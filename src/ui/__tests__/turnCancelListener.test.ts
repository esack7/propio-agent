import { createTurnCancelListener } from "../turnCancelListener.js";
import { createTtyInputStream, withKeypressEvents } from "./ttyTestStream.js";

describe("createTurnCancelListener", () => {
  it("invokes onCancel for Escape while attached and stops after detach", () => {
    const inputStream = withKeypressEvents(createTtyInputStream());
    const onCancel = jest.fn();
    const listener = createTurnCancelListener({
      input: inputStream as unknown as NodeJS.ReadStream,
      interactiveInput: true,
      onCancel,
    });

    listener.attach();
    inputStream.emit("keypress", "\u001b", { name: "escape" });
    inputStream.emit("keypress", "\u001b", { name: "escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);

    listener.detach();
    onCancel.mockClear();
    inputStream.emit("keypress", "\u001b", { name: "escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("enables raw mode on attach and disables it on detach when not already raw", () => {
    const inputStream = createTtyInputStream();
    const listener = createTurnCancelListener({
      input: inputStream as unknown as NodeJS.ReadStream,
      interactiveInput: true,
      onCancel: jest.fn(),
    });

    listener.attach();
    expect(inputStream.resume).toHaveBeenCalled();
    expect(inputStream.setRawMode).toHaveBeenCalledWith(true);

    listener.detach();
    expect(inputStream.setRawMode).toHaveBeenCalledWith(false);
    expect(inputStream.pause).toHaveBeenCalled();
  });

  it("does not attach when interactiveInput is false", () => {
    const inputStream = withKeypressEvents(createTtyInputStream());
    const onCancel = jest.fn();
    const listener = createTurnCancelListener({
      input: inputStream as unknown as NodeJS.ReadStream,
      interactiveInput: false,
      onCancel,
    });

    listener.attach();
    inputStream.emit("keypress", "\u001b", { name: "escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(inputStream.resume).not.toHaveBeenCalled();
  });
});
