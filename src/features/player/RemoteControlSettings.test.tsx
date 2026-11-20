import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteControlSettings } from "./RemoteControlSettings";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const off = { enabled: false, addresses: [], pairingCode: null };
const on = {
  enabled: true,
  addresses: ["http://192.168.1.10:19653", "http://127.0.0.1:19653"],
  pairingCode: "a".repeat(32),
};

let writeTextMock: ReturnType<typeof vi.fn>;

function expectCopyIcon(button: HTMLElement) {
  expect(button.querySelector("svg rect")).toBeInTheDocument();
}

function expectCheckIcon(button: HTMLElement) {
  expect(button.querySelector("svg rect")).not.toBeInTheDocument();
  expect(button.querySelector("svg path")).toHaveAttribute("d", "m5 12.5 4.5 4.5L19 7");
}

describe("RemoteControlSettings", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    invoke.mockReset().mockResolvedValue(off);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("shows confirmed connection information, and removes it when disabled", async () => {
    render(<RemoteControlSettings />);
    const toggle = screen.getByRole("switch", { name: "允许手机 / 平板遥控" });
    expect(toggle).toHaveClass("settings-switch");
    await waitFor(() => expect(toggle).not.toBeDisabled());

    invoke.mockResolvedValueOnce(on);
    fireEvent.click(toggle);

    expect(await screen.findByDisplayValue("http://192.168.1.10:19653")).toBeInTheDocument();
    expect(invoke).toHaveBeenLastCalledWith("remote_set_enabled", { enabled: true });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    invoke.mockResolvedValueOnce(off);
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.queryByLabelText("连接码")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenLastCalledWith("remote_set_enabled", { enabled: false });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("keeps the service disabled when binding fails", async () => {
    render(<RemoteControlSettings />);
    const toggle = screen.getByRole("switch", { name: "允许手机 / 平板遥控" });
    await waitFor(() => expect(toggle).not.toBeDisabled());

    invoke.mockRejectedValueOnce("遥控端口 19653 被占用或无法监听");
    fireEvent.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("端口");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("rejects malformed native connection data", async () => {
    invoke.mockResolvedValue({ ...on, pairingCode: "invalid" });
    render(<RemoteControlSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent("读取遥控状态失败");
    expect(screen.queryByLabelText("连接码")).not.toBeInTheDocument();
  });

  it("does not enable a server in a browser fixture", () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    render(<RemoteControlSettings />);

    expect(screen.getByRole("switch", { name: "允许手机 / 平板遥控" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("copies address, pairing code, and full link inline with temporary check icon feedback", async () => {
    invoke.mockResolvedValue(on);
    render(<RemoteControlSettings />);
    await screen.findByDisplayValue("http://192.168.1.10:19653");

    vi.useFakeTimers();

    const copyAddressBtn = screen.getByRole("button", { name: "复制地址" });
    const copyCodeBtn = screen.getByRole("button", { name: "复制连接码" });
    const copyLinkBtn = screen.getByRole("button", { name: "复制完整链接" });

    expectCopyIcon(copyAddressBtn);
    expectCopyIcon(copyCodeBtn);
    expectCopyIcon(copyLinkBtn);

    await act(async () => {
      fireEvent.click(copyAddressBtn);
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenLastCalledWith("http://192.168.1.10:19653");
    expectCheckIcon(copyAddressBtn);
    expectCopyIcon(copyCodeBtn);

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expectCopyIcon(copyAddressBtn);

    await act(async () => {
      fireEvent.click(copyCodeBtn);
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenLastCalledWith("a".repeat(32));
    expectCheckIcon(copyCodeBtn);

    await act(async () => {
      fireEvent.click(copyLinkBtn);
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenLastCalledWith(`http://192.168.1.10:19653/#code=${"a".repeat(32)}`);
    expectCheckIcon(copyLinkBtn);
    expect(copyLinkBtn).toHaveTextContent("已复制完整链接");
    expectCopyIcon(copyCodeBtn);

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expectCopyIcon(copyLinkBtn);
    expect(copyLinkBtn).toHaveTextContent("复制完整链接");
  });

  it("keeps offline SVG QR collapsed by default, toggles inline SVG, and auto-collapses when disabled or pairingCode changes", async () => {
    invoke.mockResolvedValue(on);
    render(<RemoteControlSettings />);
    await screen.findByDisplayValue("http://192.168.1.10:19653");

    expect(screen.queryByRole("region", { name: "遥控连接二维码" })).not.toBeInTheDocument();
    const qrToggle = screen.getByRole("button", { name: "显示二维码" });
    expect(qrToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(qrToggle);

    const qrRegion = screen.getByRole("region", { name: "遥控连接二维码" });
    expect(qrToggle).toHaveTextContent("收起二维码");
    expect(qrToggle).toHaveAttribute("aria-expanded", "true");
    const svg = qrRegion.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelector("rect")).toHaveAttribute("fill", "#ffffff");
    expect(svg?.querySelector("path")).toHaveAttribute("fill", "#000000");

    // Disable and re-enable with a rotated pairingCode -> stays collapsed
    const switchBtn = screen.getByRole("switch", { name: "允许手机 / 平板遥控" });
    invoke.mockResolvedValueOnce(off);
    fireEvent.click(switchBtn);
    await waitFor(() => expect(screen.queryByRole("region", { name: "遥控连接二维码" })).not.toBeInTheDocument());

    invoke.mockResolvedValueOnce({ ...on, pairingCode: "b".repeat(32) });
    fireEvent.click(switchBtn);
    await screen.findByDisplayValue("b".repeat(32));
    expect(screen.queryByRole("region", { name: "遥控连接二维码" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示二维码" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows graceful fallback message instead of crashing when QR payload exceeds 122 bytes", async () => {
    const longAddress = `http://${"192.168.1.1.".repeat(8)}1:19653`;
    const longOn = {
      enabled: true,
      addresses: [longAddress],
      pairingCode: "c".repeat(32),
    };
    invoke.mockResolvedValue(longOn);
    render(<RemoteControlSettings />);
    await screen.findByDisplayValue(longAddress);

    fireEvent.click(screen.getByRole("button", { name: "显示二维码" }));

    const qrRegion = screen.getByRole("region", { name: "遥控连接二维码" });
    expect(qrRegion.querySelector("svg")).not.toBeInTheDocument();
    expect(qrRegion).toHaveTextContent("当前连接地址过长，暂不支持二维码，请使用文字地址与连接码");
  });
});
