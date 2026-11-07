import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({ environments: [] as unknown[], update: vi.fn() }));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: ["local"] },
    environments: state.environments,
    connectedEnvironments: state.environments,
    environment: state.environments[0],
  })) as never,
}));
vi.mock(import("./settingsScopeAxis"), async (original) => ({
  ...(await original()),
  settingsScopeEnvironmentLabel: () => "Test server",
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.update) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("./SecretSourceInput"), async (original) => ({
  ...(await original()),
  useSecretSources: () => [],
}));

import { DeviceSourcesSettings } from "./DeviceSourcesSettings";

it("adds Limrun from Add source and saves its credentials on the selected server", async () => {
  state.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.environments = [
    {
      environmentId: EnvironmentId.make("local"),
      connection: { phase: "connected" },
      serverConfig: {
        settings: {
          enableDeviceSupport: true,
          deviceHosts: [],
          easDeviceHosts: [],
          simlockDeviceHosts: [],
          limrunDeviceHosts: [],
        },
      },
    },
  ];
  await using screen = await render(
    <DeviceSourcesSettings supportsEas={false} supportsSimlock={false} supportsLimrun />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add source" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Limrun", exact: true }));
  const dialog = page.getByRole("dialog", { name: "Limrun devices" });
  await expect.element(dialog).toBeVisible();
  await userEvent.fill(
    dialog.getByRole("textbox", { name: "API key", exact: true }),
    "lim_test_key",
  );
  await userEvent.click(dialog.getByRole("button", { name: "Save", exact: true }));
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        patch: {
          limrunDeviceHosts: [
            expect.objectContaining({
              kind: "limrun",
              apiKey: "lim_test_key",
              maxConcurrentSessions: 2,
            }),
          ],
        },
      },
    }),
  );
  await expect.element(dialog).not.toBeInTheDocument();
});
