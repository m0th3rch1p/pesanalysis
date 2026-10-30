import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";
import Svg, { Circle, Line, Rect, Text as SvgText } from "react-native-svg";
import {
  Camera, GeoJSONSource, Layer, Map, Marker, OfflineManager,
  type CameraRef, type OfflinePack, type OfflinePackProgressListener,
} from "@maplibre/maplibre-react-native";
import type { ExplorePlace } from "@yako/core";
import { C, text } from "../ui";

/**
 * OpenFreeMap/Dark is an OpenStreetMap-derived vector style served without an API key.
 * Tiles are only requested when Places is opened. The map is a separate rail from the
 * ledger: no transaction row, note, SMS body, counterparty or amount is sent.
 */
const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
const PACK_KEY = "pesanalysis.places.v1";
const PREVIEW_BOUNDS: [number, number, number, number] = [36.74, -1.34, 36.94, -1.22];

function boundsOf(places: ExplorePlace[]): [number, number, number, number] {
  const lats = places.map((p) => p.lat), lngs = places.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const padLat = Math.max(0.012, (maxLat - minLat) * 0.25);
  const padLng = Math.max(0.012, (maxLng - minLng) * 0.25);
  return [minLng - padLng, minLat - padLat, maxLng + padLng, maxLat + padLat];
}

function FallbackPlot({ places, height }: { places: ExplorePlace[]; height: number }) {
  const { width: win } = useWindowDimensions();
  const width = Math.min(win - 64, 560);
  if (!places.length) return null;
  const lats = places.map((p) => p.lat), lngs = places.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latSpan = Math.max(0.0008, maxLat - minLat), lngSpan = Math.max(0.0008, maxLng - minLng);
  const x = (lng: number) => 22 + ((lng - minLng) / lngSpan) * (width - 38);
  const y = (lat: number) => height - 20 - ((lat - minLat) / latSpan) * (height - 38);
  const max = Math.max(1, ...places.map((p) => p.count));
  return (
    <Svg width={width} height={height} style={{ alignSelf: "center" }}>
      <Rect x={0} y={0} width={width} height={height} rx={16} fill="#0B1220" stroke={C.line} />
      {[0.25, 0.5, 0.75].map((f) => (
        <Line key={f} x1={20} x2={width - 10} y1={20 + f * (height - 40)} y2={20 + f * (height - 40)} stroke="#172033" strokeWidth={1} strokeDasharray="3 5" />
      ))}
      {places.map((p) => (
        <Circle key={p.key} cx={x(p.lng)} cy={y(p.lat)} r={6 + Math.min(13, (p.count / max) * 11)} fill={p.spendCents >= p.incomeCents ? C.blue : C.green} opacity={0.72} />
      ))}
      <SvgText x={8} y={height - 5} fill={C.dim} fontSize={8}>offline coordinate plot · not a street map</SvgText>
    </Svg>
  );
}

export function PlacesMap({ places, preview = false }: { places: ExplorePlace[]; preview?: boolean }) {
  const camera = useRef<CameraRef>(null);
  const [online, setOnline] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [pack, setPack] = useState<OfflinePack | null>(null);
  const [download, setDownload] = useState<{ pct: number; state: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const bounds = useMemo(() => places.length ? boundsOf(places) : PREVIEW_BOUNDS, [places]);
  const geojson = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: places.map((p, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        key: p.key, count: p.count, spend: p.spendCents, income: p.incomeCents,
        label: `Area ${i + 1}`,
      },
    })),
  }), [places]);

  useEffect(() => {
    if (failed || !online) return;
    const t = setTimeout(() => {
      try { camera.current?.fitBounds(bounds, { padding: { top: 58, right: 34, bottom: 62, left: 34 }, duration: 400 }); } catch { /* map may not be ready */ }
    }, 250);
    return () => clearTimeout(t);
  }, [bounds, failed, online]);

  useEffect(() => {
    (async () => {
      try {
        const packs = await OfflineManager.getPacks();
        const found = packs.find((p) => p.metadata?.key === PACK_KEY) ?? null;
        setPack(found);
        if (found) {
          const s = await found.status();
          setDownload({ pct: s.percentage, state: s.state });
        }
      } catch { /* offline manager is optional */ }
    })();
  }, []);

  const prepareOffline = async () => {
    setMessage(null);
    try {
      const existing = pack ?? (await OfflineManager.getPacks()).find((p) => p.metadata?.key === PACK_KEY) ?? null;
      const listener: OfflinePackProgressListener = (p, status) => {
        setDownload({ pct: status.percentage, state: status.state });
        if (status.state === "complete") setPack(p);
      };
      if (existing) {
        const status = await existing.status();
        setDownload({ pct: status.percentage, state: status.state });
        if (status.state === "complete") { setPack(existing); setMessage("Offline map is ready for this area."); return; }
        await existing.resume();
        setPack(existing);
        return;
      }
      const created = await OfflineManager.createPack(
        { mapStyle: STYLE_URL, bounds, minZoom: 9, maxZoom: 15, metadata: { key: PACK_KEY, scope: "places" } },
        listener,
        (_p, error) => { setMessage(`Map download failed: ${error.message}`); setDownload(null); },
      );
      setPack(created);
    } catch (e) {
      setMessage(String(e).slice(0, 180));
    }
  };

  if (!places.length && !preview) return null;

  // Offline-first: the default view is a local coordinate scatter and never requests a tile.
  // Street-map tiles are a declared network-only feature, loaded only after an explicit tap.
  if (!online) {
    return (
      <View style={{ marginTop: 10 }}>
        <View style={{ borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: C.line }}>
          {places.length
            ? <FallbackPlot places={places} height={230} />
            : <View style={{ padding: 22, alignItems: "center" }}><Text style={text(11, C.dim)}>No located payments yet.</Text></View>}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 }}>
          <TouchableOpacity onPress={() => { setMessage(null); setOnline(true); }} accessibilityRole="button">
            <Text style={text(10, C.blue, "600")}>Show street map (uses internet) ›</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <Text style={text(9, C.dim)}>works offline</Text>
        </View>
        <Text style={[text(9, C.dim), { marginTop: 5 }]}>
          This plot is computed on your phone from payment locations. No network request is made until you open the street map.
        </Text>
      </View>
    );
  }

  if (failed) {
    if (!places.length) return <View style={{ marginTop: 10 }}><Text style={text(11, C.muted)}>Map preview could not load. Check the network or try again.</Text></View>;
    return (
      <View style={{ marginTop: 10 }}>
        <View style={{ borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: C.line }}>
          <FallbackPlot places={places} height={260} />
        </View>
        <TouchableOpacity onPress={() => { setFailed(false); setMessage(null); }} style={{ alignSelf: "flex-start", marginTop: 8 }}>
          <Text style={text(10, C.blue, "600")}>Try map again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 10 }}>
      <View style={{ height: 330, borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: C.line, backgroundColor: "#0B1220" }}>
        {!ready && (
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", zIndex: 2 }}>
            <ActivityIndicator color={C.blue} />
            <Text style={[text(10, C.dim), { marginTop: 7 }]}>Loading OpenStreetMap…</Text>
          </View>
        )}
        <Map
          mapStyle={STYLE_URL}
          style={{ flex: 1 }}
          attribution
          logo={false}
          compass={false}
          scaleBar={false}
          touchRotate={false}
          touchPitch={false}
          onDidFinishLoadingMap={() => setReady(true)}
          onDidFailLoadingMap={() => { setFailed(true); setReady(false); }}
        >
          <Camera ref={camera} initialViewState={{ bounds, padding: { top: 58, right: 34, bottom: 62, left: 34 } }} minZoom={8} maxZoom={18} />
          <GeoJSONSource id="pesanalysis-places" data={geojson} />
          <Layer
            id="pesanalysis-place-halo"
            type="circle"
            source="pesanalysis-places"
            paint={{
              "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 13, 25, 24],
              "circle-color": "#0A84FF",
              "circle-opacity": 0.18,
              "circle-stroke-width": 1,
              "circle-stroke-color": "#0A84FF",
            }}
          />
          <Layer
            id="pesanalysis-place-core"
            type="circle"
            source="pesanalysis-places"
            paint={{
              "circle-radius": 5,
              "circle-color": ["case", [">", ["get", "income"], ["get", "spend"]], C.green, C.blue],
              "circle-stroke-width": 1.5,
              "circle-stroke-color": "#FFFFFF",
            }}
          />
          {places.slice(0, 10).map((p, i) => (
            <Marker key={p.key} id={p.key} lngLat={[p.lng, p.lat]} anchor="bottom">
              <View style={{ alignItems: "center", marginBottom: 9 }}>
                <View style={{ backgroundColor: "#0B0F17E6", borderColor: C.blue, borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 3 }}>
                  <Text style={text(9, C.text, "700")}>{i + 1}</Text>
                </View>
              </View>
            </Marker>
          ))}
        </Map>
        <View pointerEvents="none" style={{ position: "absolute", left: 10, top: 8, backgroundColor: "#0B0F17CC", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 }}>
          <Text style={text(8, C.muted)}>© OpenStreetMap contributors · OpenFreeMap</Text>
        </View>
        {!places.length && (
          <View pointerEvents="none" style={{ position: "absolute", left: 10, right: 10, bottom: 10, backgroundColor: "#0B0F17CC", borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 }}>
            <Text style={text(9, C.muted)}>Map preview · no payment locations yet</Text>
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 }}>
        <TouchableOpacity onPress={() => void prepareOffline()} disabled={!!download && download.state === "active"} style={{ opacity: !!download && download.state === "active" ? 0.55 : 1 }}>
          <Text style={text(10, C.blue, "600")}>
            {download?.state === "active" ? `Downloading map ${Math.round(download.pct)}%` : download?.state === "complete" ? "Offline map ready" : "Download this area"}
          </Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={() => { try { camera.current?.fitBounds(bounds, { padding: { top: 58, right: 34, bottom: 62, left: 34 }, duration: 300 }); } catch { /* noop */ } }}>
          <Text style={text(10, C.muted, "600")}>{places.length ? "Fit places" : "Center Nairobi"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setOnline(false); setFailed(false); setReady(false); setMessage(null); }} accessibilityRole="button">
          <Text style={text(10, C.muted, "600")}>Offline view</Text>
        </TouchableOpacity>
      </View>
      {message && <Text style={[text(9, C.dim), { marginTop: 5 }]}>{message}</Text>}
      <Text style={[text(9, C.dim), { marginTop: 5 }]}>
        The basemap is OpenStreetMap data via OpenFreeMap and needs the internet. Only the viewport is requested; no payment, amount, counterparty or SMS text leaves the phone.
      </Text>
    </View>
  );
}
