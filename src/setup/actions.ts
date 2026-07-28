import { spawn } from "node:child_process";

/**
 * Copies text to the terminal's clipboard using the OSC 52 escape sequence.
 * This targets the user's local terminal emulator even when OpenWiki runs over
 * SSH, unlike shelling out to a host clipboard utility.
 */
export function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");

  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

export function openLoginUrl(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", '""', `"${url}"`], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          });

    child.on("error", () => {
      // The URL is also rendered for manual use on headless/SSH machines.
    });
    child.unref();
  } catch {
    // Ignore spawn failures; the URL is still rendered for manual use.
  }
}
