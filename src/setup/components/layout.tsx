import type React from "react";
import { Box, Text } from "ink";
import type { SetupStepState } from "../steps/machine.js";

export function SetupHeader() {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          OpenWiki
        </Text>{" "}
        <Text color="gray">first-run setup</Text>
      </Text>
      <Text>Configure the model, wiki scope, and sources.</Text>
    </Box>
  );
}

/**
 * Progress glyph per status: a check for done, an arrow for the active row, a
 * hollow circle for not-started (and optional). Single cell wide so every row's
 * label column lines up without padding the marker.
 */
const STEP_GLYPH: Record<SetupStepState, string> = {
  done: "✓",
  current: "❯",
  optional: "○",
  pending: "○",
};

/** Color per status. Optionality is conveyed by the detail text, not the glyph. */
const STEP_COLOR: Record<SetupStepState, string> = {
  done: "green",
  current: "cyan",
  optional: "gray",
  pending: "gray",
};

export function SetupStep({
  detail,
  label,
  state,
}: {
  detail: string;
  label: string;
  state: SetupStepState;
}) {
  return (
    <Text>
      <Text color={STEP_COLOR[state]}>{STEP_GLYPH[state]}</Text>{" "}
      <Text bold={state === "current" || state === "done"}>
        {label.padEnd(16)}
      </Text>{" "}
      <Text color="gray">{detail}</Text>
    </Text>
  );
}

export function SetupPanel({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function SelectionMarker({ isSelected }: { isSelected: boolean }) {
  return (
    <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>
  );
}

export function SourceConnectionStatus({
  count,
  isConfigured,
}: {
  count: number;
  isConfigured: boolean;
}) {
  return (
    <Text color={isConfigured ? "green" : "gray"}>
      {isConfigured
        ? `[configured${count > 1 ? ` x${count}` : ""}]`
        : "[not configured]"}
    </Text>
  );
}
