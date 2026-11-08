import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, OwnerPanel } from "../src/components/owner.tsx";

const confirming = { kind: "confirming", signer: "owner.testnet", req: { method: "revoke_delegate", args: {}, title: "Revoke Buyer" } } as Parameters<typeof ConfirmDialog>[0]["phase"];

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <ConfirmDialog phase={open ? confirming : { kind: "idle" }} onConfirm={() => {}} onCancel={() => setOpen(false)} />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("keeps Tab inside the dialog and returns focus on close", () => {
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    const sign = screen.getByRole("button", { name: "Sign with wallet" });
    expect(document.activeElement).toBe(sign);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(sign);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("OwnerPanel", () => {
  it("disables Create and says why when the crew cap is invalid", () => {
    render(<OwnerPanel task="board-1" request={vi.fn()} busy={false} />);
    fireEvent.change(screen.getByLabelText("Task id"), { target: { value: "board-2" } });
    const create = screen.getByRole("button", { name: "Create task…" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/^Crew cap/), { target: { value: "999" } });
    expect(create.disabled).toBe(true);
    expect(screen.getByText("Enter a whole number from 1 to 255.")).toBeTruthy();
  });
});
