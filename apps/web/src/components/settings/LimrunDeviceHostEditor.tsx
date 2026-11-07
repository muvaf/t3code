import { useState } from "react";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  LimrunDeviceHostConfig,
  isSecretReference,
  type EnvironmentId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

const decode = Schema.decodeUnknownOption(LimrunDeviceHostConfig);
export function LimrunDeviceHostEditor(props: {
  host: LimrunDeviceHostConfig;
  environmentId: EnvironmentId;
  busy: boolean;
  onSave: (host: LimrunDeviceHostConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(props.host);
  const [key, setKey] = useState<SettingsSecretValue | undefined>(undefined);
  const [validKey, setValidKey] = useState(true);
  const sources = useSecretSources(props.environmentId);
  const next = {
    ...draft,
    label: draft.label.trim(),
    region: draft.region.trim(),
    apiKey: key ?? props.host.apiKey,
  };
  const valid = validKey && Option.isSome(decode(next));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Limrun devices</DialogTitle>
          <DialogDescription>
            Run iOS simulators and Android emulators in Limrun. Stop devices when finished; each
            also has a maximum duration.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1 text-sm">
            Name
            <Input
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              disabled={props.busy}
            />
          </label>
          <div className="space-y-1 text-sm">
            <label htmlFor="limrun-key">API key</label>
            <SecretSourceInput
              id="limrun-key"
              sources={sources}
              configured={
                key === undefined && typeof props.host.apiKey === "string" && !!props.host.apiKey
              }
              value={key ?? (isSecretReference(props.host.apiKey) ? props.host.apiKey : "")}
              onValidityChange={setValidKey}
              onSecretChange={(value) => setKey(value ?? "")}
              onChange={(e) => setKey(e.target.value || undefined)}
              disabled={props.busy}
              placeholder="LIMRUN_API_KEY on the server"
            />
            <Button variant="ghost" size="sm" onClick={() => setKey("")} disabled={props.busy}>
              Clear saved key
            </Button>
          </div>
          <label className="block space-y-1 text-sm">
            Region
            <Input
              value={draft.region}
              placeholder="Automatic"
              onChange={(e) => setDraft({ ...draft, region: e.target.value })}
              disabled={props.busy}
            />
          </label>
          {(
            [
              {
                field: "maxConcurrentSessions",
                label: "Maximum concurrent devices",
                min: 1,
                max: 20,
              },
              { field: "maxSessionMinutes", label: "Maximum duration (minutes)", min: 5, max: 240 },
              { field: "idleMinutes", label: "Idle timeout (minutes)", min: 1, max: 60 },
            ] as const
          ).map(({ field, label, min, max }) => (
            <label key={field} className="block space-y-1 text-sm">
              {label}
              <Input
                type="number"
                min={min}
                max={max}
                value={draft[field]}
                onChange={(e) => setDraft({ ...draft, [field]: Number(e.target.value) })}
                disabled={props.busy}
              />
            </label>
          ))}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.busy}>
            Cancel
          </Button>
          <Button disabled={!valid || props.busy} onClick={() => props.onSave(next)}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
