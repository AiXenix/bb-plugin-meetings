// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);
const handlers = {
  "meetings.list": () => ({ meetings: [], nextBefore: null }),
  "env.status": () => ({ env: null, error: null }),
  "calendar.status": () => ({ configured: false, autoJoin: false, feeds: 0, lastSyncAt: null, lastError: null, upcoming: [] }),
  "google.status": () => ({ configured: false, connected: false, calendars: [], clientId: "", lastError: null }),
};

it("imports an absolute recording-host path and opens the new meeting without submitting join", async () => {
  const app = await loadPluginApp(() => import("../../app"));
  const slot = await renderSlot(app.navPanels[0]!, { subPath: "" }, { pluginId: "meetings", rpc: { ...handlers, "meetings.import": () => ({ meeting: { id: "mtg_import01", status: "processing" } }) } as never });
  fireEvent.click(await screen.findByRole("button", { name: "Импорт записи" }));
  const dialog = await screen.findByRole("dialog", { name: "Импорт аудио или видео" });
  expect(within(dialog).getByText(/Браузер не загружает файл с вашего устройства/)).toBeTruthy();
  const path = within(dialog).getByRole("textbox", { name: "Путь к файлу на машине записи" });
  fireEvent.change(path, { target: { value: "recording.mp4" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Импортировать" }));
  await within(dialog).findByRole("alert");
  expect(slot.inspection.rpcCalls.filter(call => call.method === "meetings.import")).toEqual([]);
  fireEvent.change(path, { target: { value: " /recordings/team-call.mp4 " } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Название записи (необязательно)" }), { target: { value: " Недельный созвон " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Импортировать" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "meetings", options: { subPath: "mtg_import01" } }));
  expect(slot.inspection.rpcCalls.filter(call => call.method === "meetings.import").map(call => call.input)).toEqual([{ sourcePath: "/recordings/team-call.mp4", title: "Недельный созвон" }]);
  expect(slot.inspection.rpcCalls.filter(call => call.method === "meetings.join")).toEqual([]);
  slot.lifecycle.unmount();
});

it("shows import errors in the dialog and preserves the entered path for correction", async () => {
  const app = await loadPluginApp(() => import("../../app"));
  const slot = await renderSlot(app.navPanels[0]!, { subPath: "" }, { pluginId: "meetings", rpc: { ...handlers, "meetings.import": () => { throw new Error("Файл на машине записи не найден"); } } as never });
  fireEvent.click(await screen.findByRole("button", { name: "Импорт записи" }));
  const dialog = await screen.findByRole("dialog");
  const path = within(dialog).getByRole("textbox", { name: "Путь к файлу на машине записи" });
  fireEvent.change(path, { target: { value: "/recordings/missing.wav" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Импортировать" }));
  await within(dialog).findByText("Файл на машине записи не найден");
  expect((path as HTMLInputElement).value).toBe("/recordings/missing.wav");
  expect(slot.inspection.navigateCalls).toEqual([]);
  slot.lifecycle.unmount();
});
