import { useEffect, useState } from "react";
import { Modal, ScrollView, Share, Text, TextInput, TouchableOpacity, View } from "react-native";
import { passphraseStrength } from "@yako/core";
import { Btn, C, Card, text } from "../ui";

const Backdrop = ({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) => (
  <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: 20 }}>
      <Card style={{ maxHeight: "92%" }}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={text(18, C.text, "700")}>{title}</Text>
          {children}
        </ScrollView>
      </Card>
    </View>
  </Modal>
);

const input = { backgroundColor: C.card2, color: C.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 6, fontSize: 15 } as const;
const STRENGTH_COLOR = [C.red, C.amber, C.amber, C.green] as const;

/**
 * Reusable passphrase modal.
 *  mode "create": passphrase + confirm + strength hint + loss warning, min 8 chars.
 *  mode "enter": single field (restore), optional recovery-code alternative.
 */
export function PassphraseModal(props: {
  mode: "create" | "enter";
  title?: string;
  busy?: boolean;
  error?: string | null;
  allowRecovery?: boolean;
  onSubmit: (s: { passphrase?: string; recoveryCode?: string }) => void;
  onCancel: () => void;
}) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [useCode, setUseCode] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => () => { setPass(""); setConfirm(""); setCode(""); }, []);
  const create = props.mode === "create";
  const st = passphraseStrength(pass);
  const mismatch = create && confirm.length > 0 && confirm !== pass;
  const ok = useCode ? code.trim().length >= 8 : pass.length >= 8 && (!create || (confirm === pass));
  const submit = () => {
    if (!ok || props.busy) return;
    props.onSubmit(useCode ? { recoveryCode: code.trim() } : { passphrase: pass });
  };
  return (
    <Backdrop onClose={props.onCancel} title={props.title ?? (create ? "Protect this backup" : "Unlock backup")}>
      {create ? (
        <Text style={[text(13, C.muted), { marginTop: 8, lineHeight: 19 }]}>
          The backup is encrypted on this phone. If you lose BOTH the passphrase and the recovery code you get next, the backup cannot be recovered by anyone, including us.
        </Text>
      ) : null}
      {useCode ? (
        <>
          <Text style={[text(12, C.muted), { marginTop: 12 }]}>Recovery code</Text>
          <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            placeholderTextColor={C.dim} style={input} accessibilityLabel="Recovery code" editable={!props.busy} />
        </>
      ) : (
        <>
          <Text style={[text(12, C.muted), { marginTop: 12 }]}>Passphrase</Text>
          <TextInput value={pass} onChangeText={setPass} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false} autoComplete="off"
            textContentType="none" importantForAutofill="no" style={input} accessibilityLabel="Passphrase" editable={!props.busy}
            returnKeyType={create ? "next" : "done"} onSubmitEditing={create ? undefined : submit} />
          {create ? (
            <>
              <Text accessibilityLiveRegion="polite" style={[text(12, STRENGTH_COLOR[st.score]), { marginTop: 4 }]}>{pass ? st.label : "At least 8 characters. A phrase of several words is best."}</Text>
              <Text style={[text(12, C.muted), { marginTop: 10 }]}>Confirm passphrase</Text>
              <TextInput value={confirm} onChangeText={setConfirm} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false} autoComplete="off"
                textContentType="none" importantForAutofill="no" style={input} accessibilityLabel="Confirm passphrase" editable={!props.busy} onSubmitEditing={submit} />
              {mismatch ? <Text accessibilityLiveRegion="polite" style={[text(12, C.red), { marginTop: 4 }]}>Passphrases do not match.</Text> : null}
            </>
          ) : null}
          <TouchableOpacity onPress={() => setShow((s) => !s)} accessibilityRole="switch" accessibilityState={{ checked: show }} style={{ paddingVertical: 10 }}>
            <Text style={text(13, C.blue)}>{show ? "Hide passphrase" : "Show passphrase"}</Text>
          </TouchableOpacity>
        </>
      )}
      {props.error ? <Text accessibilityLiveRegion="assertive" style={[text(13, C.red), { marginTop: 6 }]}>{props.error}</Text> : null}
      {props.busy ? <Text accessibilityLiveRegion="polite" style={[text(13, C.muted), { marginTop: 6 }]}>Working. Encryption is deliberately slow; keep the app open.</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
        <Btn label="Cancel" kind="ghost" onPress={props.onCancel} disabled={props.busy} style={{ flex: 1 }} />
        <Btn label={create ? "Encrypt backup" : "Unlock"} onPress={submit} disabled={!ok || props.busy} style={{ flex: 1 }} />
      </View>
      {props.allowRecovery ? (
        <TouchableOpacity onPress={() => setUseCode((u) => !u)} style={{ paddingVertical: 12, alignItems: "center" }} accessibilityRole="button">
          <Text style={text(13, C.blue)}>{useCode ? "Use passphrase instead" : "Use recovery code instead"}</Text>
        </TouchableOpacity>
      ) : null}
    </Backdrop>
  );
}

/** Shows the recovery code once. Cannot be dismissed until the user confirms it was stored. */
export function RecoveryCodeModal({ code, onDone, note }: { code: string; onDone: () => void; note?: string }) {
  const [stored, setStored] = useState(false);
  return (
    <Backdrop onClose={() => undefined} title="Your recovery code">
      <Text style={[text(13, C.muted), { marginTop: 8, lineHeight: 19 }]}>
        This code opens the backup if you forget the passphrase. It is shown once and is not stored anywhere on this phone. Write it down or save it in a password manager, away from the backup file.
      </Text>
      <Text selectable accessibilityLabel={`Recovery code ${code.replace(/-/g, " ").split("").join(" ")}`}
        style={[text(18, C.text, "700"), { marginTop: 14, letterSpacing: 1, lineHeight: 28, textAlign: "center", fontFamily: "monospace" }]}>{code}</Text>
      <Text style={[text(11, C.dim), { marginTop: 6, textAlign: "center" }]}>Press and hold the code to copy it.</Text>
      {note ? <Text accessibilityLiveRegion="polite" style={[text(11, C.amber), { marginTop: 8, lineHeight: 16 }]}>{note}</Text> : null}
      <Btn label="Share or copy via share sheet" kind="soft" style={{ marginTop: 10 }} onPress={() => { void Share.share({ message: code }); }} />
      <TouchableOpacity onPress={() => setStored((s) => !s)} accessibilityRole="checkbox" accessibilityState={{ checked: stored }}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 }}>
        <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: C.blue, backgroundColor: stored ? C.blue : "transparent" }} />
        <Text style={[text(14, C.text), { flex: 1 }]}>I stored this recovery code somewhere safe</Text>
      </TouchableOpacity>
      <Btn label="Continue" onPress={onDone} disabled={!stored} style={{ marginTop: 14 }} />
    </Backdrop>
  );
}

/** Destructive confirmation: the button stays disabled until the user types the word. */
export function TypeToConfirmModal(props: { title: string; body: string; word: string; actionLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [v, setV] = useState("");
  const ok = v.trim().toUpperCase() === props.word.toUpperCase();
  return (
    <Backdrop onClose={props.onCancel} title={props.title}>
      <Text style={[text(13, C.muted), { marginTop: 8, lineHeight: 19 }]}>{props.body}</Text>
      <Text style={[text(12, C.muted), { marginTop: 12 }]}>{`Type ${props.word} to confirm`}</Text>
      <TextInput value={v} onChangeText={setV} autoCapitalize="characters" autoCorrect={false} style={input} accessibilityLabel={`Type ${props.word} to confirm`} editable={!props.busy} />
      <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
        <Btn label="Cancel" kind="ghost" onPress={props.onCancel} disabled={props.busy} style={{ flex: 1 }} />
        <Btn label={props.actionLabel} onPress={props.onConfirm} disabled={!ok || props.busy} style={{ flex: 1 }} />
      </View>
    </Backdrop>
  );
}
