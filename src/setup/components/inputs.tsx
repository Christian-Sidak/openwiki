import { Box, Text } from "ink";
import {
  formatSecretInputDisplay,
  getSingleLineInputDisplayValue,
} from "../display.js";
import { CRON_FIELD_LABELS, getCronFields } from "../inputs/cron.js";

export function InputValueWithCursor({
  maxDisplayWidth,
  secret = false,
  showCursor = true,
  value,
}: {
  maxDisplayWidth: number;
  secret?: boolean;
  showCursor?: boolean;
  value: string;
}) {
  if (secret) {
    const displayValue = getSingleLineInputDisplayValue(
      formatSecretInputDisplay(value),
      maxDisplayWidth,
    );

    return (
      <>
        <Text color={value.length > 0 ? "yellow" : "gray"}>{displayValue}</Text>
        {showCursor ? <Text inverse> </Text> : null}
      </>
    );
  }

  const displayValue = getSingleLineInputDisplayValue(value, maxDisplayWidth);

  return (
    <>
      {displayValue ? <Text color="yellow">{displayValue}</Text> : null}
      {showCursor ? <Text inverse> </Text> : null}
    </>
  );
}

export function BorderedInput({
  borderColor = "cyan",
  maxDisplayWidth,
  marginTop,
  prefix,
  secret = false,
  showCursor = true,
  value,
}: {
  borderColor?: "cyan" | "gray";
  maxDisplayWidth: number;
  marginTop?: number;
  prefix?: string;
  secret?: boolean;
  showCursor?: boolean;
  value: string;
}) {
  const prompt = prefix ? "$ " : "> ";
  const prefixText = prefix ? `${prefix} ` : "";
  const valueDisplayWidth = Math.max(
    1,
    maxDisplayWidth - prompt.length - prefixText.length - (showCursor ? 1 : 0),
  );

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      marginTop={marginTop}
      paddingX={1}
      width={maxDisplayWidth + 4}
    >
      <Text wrap="truncate">
        <Text color="gray">{prompt}</Text>
        {prefixText ? <Text color="gray">{prefixText}</Text> : null}
        <InputValueWithCursor
          maxDisplayWidth={valueDisplayWidth}
          secret={secret}
          showCursor={showCursor}
          value={value}
        />
      </Text>
    </Box>
  );
}

export function BorderedMultilineInput({
  borderColor = "cyan",
  maxDisplayWidth,
  marginTop,
  showCursor = true,
  value,
}: {
  borderColor?: "cyan" | "gray";
  maxDisplayWidth: number;
  marginTop?: number;
  showCursor?: boolean;
  value: string;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      flexDirection="column"
      marginTop={marginTop}
      paddingX={1}
      width={maxDisplayWidth + 4}
    >
      <Text wrap="wrap">
        <Text color="gray">&gt; </Text>
        {value ? <Text color="yellow">{value}</Text> : null}
        {showCursor ? <Text inverse> </Text> : null}
      </Text>
    </Box>
  );
}

export function SegmentedCronInput({
  activeFieldIndex,
  expression,
  fallbackExpression,
  maxDisplayWidth,
}: {
  activeFieldIndex: number;
  expression: string;
  fallbackExpression: string;
  maxDisplayWidth: number;
}) {
  const fields = getCronFields(expression, fallbackExpression);
  const fieldDisplayWidth = Math.max(
    8,
    Math.min(14, Math.floor(maxDisplayWidth / CRON_FIELD_LABELS.length) - 1),
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {fields.map((field, index) => (
          <Box
            flexDirection="column"
            marginRight={1}
            key={CRON_FIELD_LABELS[index]}
          >
            <Text color="gray">{CRON_FIELD_LABELS[index]}</Text>
            <BorderedInput
              borderColor={index === activeFieldIndex ? "cyan" : "gray"}
              maxDisplayWidth={fieldDisplayWidth}
              showCursor={index === activeFieldIndex}
              value={field}
            />
          </Box>
        ))}
      </Box>
      <Text color="gray">Cron: {fields.join(" ")}</Text>
    </Box>
  );
}
