// @vitest-environment jsdom
// The "Бот" card (bot name and avatar) against mocked RPC handlers, and the
// browser-side avatar preparation (crop/scale on a canvas, size checks).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { EnvReport } from "../shared/contract";
import type { BotProfile } from "../shared/rpc-contract";
import { AVATAR_MAX_BYTES, AvatarImageError, prepareAvatar } from "./avatar-image";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handlers = Record<string, (input: never) => unknown>;

/** A 1×1 transparent PNG. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

function fileFromDataUrl(dataUrl: string, name: string): File {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl)!;
  const bytes = Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0));
  return new File([bytes], name, { type: match[1] });
}

const READY_ENV: EnvReport = {
  ready: true,
  items: [],
  setup: { phase: "idle", message: "", startedAt: null, finishedAt: null, logTail: "" },
  runtimeHash: "abc",
  hostDataDir: "/tmp/meetings",
  sudo: true,
  gigaam: { url: "http://127.0.0.1:38271", ready: true, detail: "" },
  chromePath: "/usr/bin/google-chrome-stable",
};

function handlers(overrides: Handlers): Handlers {
  return {
    "meetings.list": () => ({ meetings: [], nextBefore: null }),
    "env.status": () => ({ env: READY_ENV, error: null }),
    "zoom.status": () => ({
      useZoomAccount: false,
      profile: { exists: false, signedIn: false, updatedAt: null },
      session: null,
    }),
    "calendar.status": () => ({
      configured: false,
      autoJoin: false,
      feeds: 0,
      lastSyncAt: null,
      lastError: null,
      upcoming: [],
    }),
    "google.status": () => ({
      configured: false,
      clientId: "",
      callbackPath: "/api/v1/plugins/meetings/http/google/callback",
      connected: false,
      email: null,
      calendars: [],
      lastSyncAt: null,
      lastError: null,
      upcomingCount: 0,
    }),
    "notetaker.settings": () => ({ settings: {} }),
    ...overrides,
  };
}

async function renderList(rpc: Handlers): Promise<RenderedSlot> {
  const app = await loadPluginApp(() => import("../../app"));
  const slot = await renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc as never, pluginId: "meetings" });
  const settings = screen.getByText("Настройки бота, разбора и интеграций").closest("details")!;
  act(() => { settings.open = true; fireEvent(settings, new Event("toggle")); });
  fireEvent.click(await screen.findByRole("tab", { name: "Бот" }));
  return slot;
}

const callsTo = (slot: RenderedSlot, method: string) =>
  slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);

/** The bot card's region (the "Бот" section). */
async function botSection(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Бот" });
}

describe("bot card", () => {
  it("renames the bot, uploads (file input and drop), toggles and removes the avatar, follows realtime", async () => {
    let profile: BotProfile = { botName: "Notetaker", avatar: { hasAvatar: false, enabled: true, version: null } };
    let failUpload = false;
    const slot = await renderList(
      handlers({
        "bot.profile": () => profile,
        "bot.updateProfile": (input: { botName?: string; showAvatar?: boolean }) => {
          profile = {
            botName: input.botName ?? profile.botName,
            avatar: { ...profile.avatar, enabled: input.showAvatar ?? profile.avatar.enabled },
          };
          return profile;
        },
        "bot.setAvatar": () => {
          if (failUpload) throw new Error("Не удалось обработать изображение на хосте");
          profile = {
            ...profile,
            avatar: { ...profile.avatar, hasAvatar: true, version: (profile.avatar.version ?? 0) + 5 },
          };
          return profile;
        },
        "bot.clearAvatar": () => {
          profile = { ...profile, avatar: { ...profile.avatar, hasAvatar: false, version: null } };
          return profile;
        },
      }),
    );
    const section = await botSection();
    await within(section).findByText("Notetaker");
    expect(within(section).getByText("Аватара нет")).toBeTruthy();
    expect(within(section).queryByRole("img")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Удалить аватар" })).toBeNull();
    expect(within(section).getByText(/Пока аватара нет, камера бота выключена/)).toBeTruthy();
    expect(within(section).getByText(/под которым бот появляется в списке участников/)).toBeTruthy();

    // Inline rename: an empty name is refused locally, Enter commits.
    fireEvent.click(within(section).getByRole("button", { name: "Изменить имя бота" }));
    let input = within(section).getByRole("textbox", { name: "Имя бота во встрече" });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await within(section).findByRole("alert")).textContent).toBe("Имя не может быть пустым");
    fireEvent.click(within(section).getByRole("button", { name: "Изменить имя бота" }));
    input = within(section).getByRole("textbox", { name: "Имя бота во встрече" });
    fireEvent.change(input, { target: { value: "Протоколист" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await within(section).findByText("Протоколист");
    expect(callsTo(slot, "bot.updateProfile")).toEqual([{ botName: "Протоколист" }]);
    expect(within(section).queryByRole("alert")).toBeNull();

    // Upload through the file input: jsdom has no createImageBitmap, so the small original goes as is.
    const fileInput = within(section).getByLabelText("Файл аватара") as HTMLInputElement;
    expect(fileInput.accept).toBe("image/png,image/jpeg,image/webp");
    const png = fileFromDataUrl(TINY_PNG_DATA_URL, "avatar.png");
    fireEvent.change(fileInput, { target: { files: [png] } });
    const preview = await within(section).findByRole("img", { name: "Камера бота: аватар и имя «Протоколист»" });
    expect(callsTo(slot, "bot.setAvatar")).toEqual([{ imageBase64: TINY_PNG_BASE64, mimeType: "image/png" }]);
    expect(preview.getAttribute("src")).toBe(
      "/api/v1/plugins/meetings/http/bot/avatar-preview?v=5&name=%D0%9F%D1%80%D0%BE%D1%82%D0%BE%D0%BA%D0%BE%D0%BB%D0%B8%D1%81%D1%82",
    );
    expect(within(section).getByRole("button", { name: "Заменить аватар" })).toBeTruthy();
    expect(within(section).getByText(/Бот включает камеру/)).toBeTruthy();

    // Drag and drop onto the card: the preview shows the drop hint, a dropped image replaces the avatar.
    const zone = section.querySelector("[data-avatar-dropzone]")!;
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(within(section).getByText("Отпустите, чтобы загрузить")).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [png] } });
    await waitFor(() => expect(callsTo(slot, "bot.setAvatar")).toHaveLength(2));
    expect(within(section).queryByText("Отпустите, чтобы загрузить")).toBeNull();
    await waitFor(() => expect(within(section).getByRole("img").getAttribute("src")).toMatch(/avatar-preview\?v=10&/));

    // Wrong type and an oversized file are refused before any upload.
    fireEvent.drop(zone, {
      dataTransfer: { types: ["Files"], files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    expect((await within(section).findByRole("alert")).textContent).toBe("Подойдёт изображение PNG, JPEG или WebP");
    const huge = new File([new Uint8Array(AVATAR_MAX_BYTES + 1024)], "huge.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [huge] } });
    await waitFor(() =>
      expect(within(section).getByRole("alert").textContent).toBe(
        "Изображение слишком большое (3,1 МБ) — нужно не больше 3 МБ",
      ),
    );
    expect(callsTo(slot, "bot.setAvatar")).toHaveLength(2);

    // A host-side failure is shown inline.
    failUpload = true;
    fireEvent.change(fileInput, { target: { files: [png] } });
    await waitFor(() =>
      expect(within(section).getByRole("alert").textContent).toBe("Не удалось обработать изображение на хосте"),
    );

    // The camera toggle.
    const toggle = within(section).getByRole("checkbox", { name: "Показывать аватар во встречах (камера бота)" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(callsTo(slot, "bot.updateProfile").at(-1)).toEqual({ showAvatar: false });
    expect(within(section).getByText(/Камера бота выключена — участники видят только имя/)).toBeTruthy();

    // Remove the avatar.
    fireEvent.click(within(section).getByRole("button", { name: "Удалить аватар" }));
    await within(section).findByText("Аватара нет");
    expect(callsTo(slot, "bot.clearAvatar")).toEqual([null]);
    expect(within(section).queryByRole("img")).toBeNull();

    // Changes made elsewhere (CLI, another tab) arrive through the meetings.bot signal.
    profile = { botName: "Секретарь", avatar: { hasAvatar: true, enabled: true, version: 42 } };
    await slot.behavior.emitRealtime("meetings.bot", {});
    await within(section).findByText("Секретарь");
    expect(within(section).getByRole("img").getAttribute("src")).toMatch(/avatar-preview\?v=42&name=/);
    slot.lifecycle.unmount();
  });

  it("returns keyboard focus to the edit button after Enter or Escape, not after a click elsewhere", async () => {
    let profile: BotProfile = { botName: "Notetaker", avatar: { hasAvatar: false, enabled: true, version: null } };
    let saving: { resolve: () => void } | null = null;
    const slot = await renderList(
      handlers({
        "bot.profile": () => profile,
        "bot.updateProfile": (input: { botName?: string }) =>
          new Promise<BotProfile>((resolve) => {
            saving = {
              resolve: () => {
                profile = { ...profile, botName: input.botName ?? profile.botName };
                resolve(profile);
              },
            };
          }),
      }),
    );
    const section = await botSection();
    const editButton = () => within(section).getByRole("button", { name: "Изменить имя бота" });
    await within(section).findByText("Notetaker");

    // Enter: focus comes back to the button, which stays focusable (aria-disabled) while saving.
    editButton().focus();
    fireEvent.click(editButton());
    let input = within(section).getByRole("textbox", { name: "Имя бота во встрече" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Протоколист" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(editButton());
    expect(editButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(editButton());
    expect(within(section).queryByRole("textbox", { name: "Имя бота во встрече" })).toBeNull();
    await act(async () => saving!.resolve());
    await waitFor(() => expect(editButton().hasAttribute("aria-disabled")).toBe(false));
    expect(within(section).getByText("Протоколист")).toBeTruthy();
    expect(document.activeElement).toBe(editButton());

    // Escape.
    fireEvent.click(editButton());
    input = within(section).getByRole("textbox", { name: "Имя бота во встрече" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(editButton());

    // A click elsewhere commits by blur and leaves the focus where the user put it.
    fireEvent.click(editButton());
    input = within(section).getByRole("textbox", { name: "Имя бота во встрече" });
    fireEvent.change(input, { target: { value: "Секретарь" } });
    const upload = within(section).getByRole("button", { name: "Загрузить аватар" });
    act(() => upload.focus());
    expect(within(section).queryByRole("textbox", { name: "Имя бота во встрече" })).toBeNull();
    expect(document.activeElement).toBe(upload);
    await act(async () => saving!.resolve());
    await within(section).findByText("Секретарь");
    slot.lifecycle.unmount();
  });

  it("retries a failed avatar preview on a fresh profile and on «Повторить»", async () => {
    let fetches = 0;
    const slot = await renderList(
      handlers({
        "bot.profile": () => {
          fetches += 1;
          return { botName: "Notetaker", avatar: { hasAvatar: true, enabled: true, version: 123 } };
        },
      }),
    );
    const section = await botSection();
    const base = "/api/v1/plugins/meetings/http/bot/avatar-preview?v=123&name=Notetaker";
    let img = await within(section).findByRole("img");
    expect(img.getAttribute("src")).toBe(base);
    fireEvent.error(img);
    await within(section).findByText("Не удалось показать превью");

    // meetings.bot (or a reconnect) brings the same profile again: the preview is asked for anew.
    const before = fetches;
    await slot.behavior.emitRealtime("meetings.bot", {});
    await waitFor(() => expect(fetches).toBeGreaterThan(before));
    img = await within(section).findByRole("img");
    expect(img.getAttribute("src")).toBe(`${base}&retry=1`);
    expect(within(section).queryByText("Не удалось показать превью")).toBeNull();

    fireEvent.error(img);
    fireEvent.click(await within(section).findByRole("button", { name: "Повторить" }));
    img = await within(section).findByRole("img");
    expect(img.getAttribute("src")).toBe(`${base}&retry=2`);
    fireEvent.load(img);
    expect(within(section).queryByText("Не удалось показать превью")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("takes file drags on the whole card, padding included, also before the profile has loaded", async () => {
    let loadProfile!: () => void;
    const slot = await renderList(
      handlers({
        "bot.profile": () =>
          new Promise<BotProfile>((resolve) => {
            loadProfile = () =>
              resolve({ botName: "Notetaker", avatar: { hasAvatar: false, enabled: true, version: null } });
          }),
        "bot.setAvatar": () => ({ botName: "Notetaker", avatar: { hasAvatar: true, enabled: true, version: 7 } }),
      }),
    );
    const section = await botSection();
    // The bordered card around the content: a drop that misses the content lands on it.
    const card = (await within(section).findByText(/Загружаем профиль бота/)).parentElement!;
    const png = fileFromDataUrl(TINY_PNG_DATA_URL, "avatar.png");
    const files = (list: File[]) => ({ dataTransfer: { types: ["Files"], files: list, dropEffect: "none" } });

    // Still loading: the browser must not open the file, and nothing is uploaded.
    expect(fireEvent.dragOver(card, files([]))).toBe(false);
    expect(fireEvent.drop(card, files([png]))).toBe(false);
    expect(callsTo(slot, "bot.setAvatar")).toEqual([]);

    await act(async () => loadProfile());
    await within(section).findByText("Аватара нет");
    expect(within(section).getByText("Имя во встрече").closest("[data-avatar-dropzone]")).toBe(card);
    expect(fireEvent.dragEnter(card, files([]))).toBe(false);
    expect(within(section).getByText("Отпустите, чтобы загрузить")).toBeTruthy();
    expect(fireEvent.dragOver(card, files([]))).toBe(false);
    expect(fireEvent.drop(card, files([png]))).toBe(false);
    await waitFor(() => expect(callsTo(slot, "bot.setAvatar")).toHaveLength(1));
    expect(within(section).queryByText("Отпустите, чтобы загрузить")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows a load error instead of the card", async () => {
    const slot = await renderList(
      handlers({
        "bot.profile": () => {
          throw new Error("host offline");
        },
      }),
    );
    const section = await botSection();
    expect((await within(section).findByRole("alert")).textContent).toBe(
      "Не удалось загрузить профиль бота: host offline",
    );
    slot.lifecycle.unmount();
  });
});

describe("prepareAvatar on a canvas", () => {
  function stubCanvas(blobSize: (type: string) => number) {
    const drawImage = vi.fn();
    const context = { drawImage, imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
    const sizes: Array<{ width: number; height: number }> = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      sizes.push({ width: this.width, height: this.height });
      return context as never;
    });
    const types: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type = "image/png") => {
      types.push(type);
      callback(new Blob([new Uint8Array(blobSize(type))], { type }));
    });
    return { drawImage, sizes, types };
  }

  function stubBitmap(width: number, height: number) {
    const bitmap = { width, height, close: vi.fn() };
    const create = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", create);
    return { bitmap, create };
  }

  it("crops the centered square, scales it to 1024 px and keeps PNG for PNG sources", async () => {
    const { bitmap, create } = stubBitmap(3000, 4000);
    const canvas = stubCanvas(() => 2048);
    const source = new File([new Uint8Array(5 * 1024 * 1024)], "photo.png", { type: "image/png" });
    const avatar = await prepareAvatar(source);
    expect(create).toHaveBeenCalledWith(source, { imageOrientation: "from-image" });
    expect(canvas.sizes).toEqual([{ width: 1024, height: 1024 }]);
    expect(canvas.drawImage).toHaveBeenCalledWith(bitmap, 0, 500, 3000, 3000, 0, 0, 1024, 1024);
    expect(canvas.types).toEqual(["image/png"]);
    expect(avatar).toMatchObject({ mimeType: "image/png", bytes: 2048, processed: true });
    expect(atob(avatar.base64).length).toBe(2048);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it("keeps small images at their size, re-encodes JPEG as JPEG and falls back to JPEG for a huge PNG", async () => {
    stubBitmap(600, 400);
    let canvas = stubCanvas(() => 1000);
    const jpeg = await prepareAvatar(new File([new Uint8Array(10)], "a.jpg", { type: "image/jpeg" }));
    expect(canvas.drawImage).toHaveBeenCalledWith(expect.anything(), 100, 0, 400, 400, 0, 0, 400, 400);
    expect(canvas.types).toEqual(["image/jpeg"]);
    expect(jpeg.mimeType).toBe("image/jpeg");

    vi.restoreAllMocks();
    canvas = stubCanvas((type) => (type === "image/png" ? AVATAR_MAX_BYTES + 1 : 500_000));
    const webp = await prepareAvatar(new File([new Uint8Array(10)], "a.webp", { type: "image/webp" }));
    expect(canvas.types).toEqual(["image/png", "image/jpeg"]);
    expect(webp).toMatchObject({ mimeType: "image/jpeg", bytes: 500_000 });
  });

  it("reports images it cannot decode and files that are too big to try", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      }),
    );
    await expect(prepareAvatar(new File([new Uint8Array(10)], "x.png", { type: "image/png" }))).rejects.toThrow(
      "Не удалось открыть изображение — файл повреждён или формат не поддерживается",
    );
    await expect(
      prepareAvatar(new File([new Uint8Array(26 * 1024 * 1024)], "x.png", { type: "image/png" })),
    ).rejects.toBeInstanceOf(AvatarImageError);
    await expect(prepareAvatar(new File([], "x.png", { type: "image/png" }))).rejects.toThrow("Файл пустой");
  });
});
