/**
 * Step-based logger for deployment progress.
 *
 * Outputs numbered steps with colored prefixes for easy
 * scanning in CI logs.
 */

let currentStep = 0;

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
} as const;

/**
 * Reset the step counter (useful for tests).
 */
export function resetSteps(): void {
  currentStep = 0;
}

/**
 * Log a numbered step.
 */
export function step(message: string): void {
  currentStep++;
  console.log(
    `\n${COLORS.cyan}${COLORS.bold}[${currentStep}]${COLORS.reset} ${message}`,
  );
}

/**
 * Log an info message.
 */
export function info(message: string): void {
  console.log(`${COLORS.dim}    ${message}${COLORS.reset}`);
}

/**
 * Log a success message.
 */
export function success(message: string): void {
  console.log(
    `\n${COLORS.green}${COLORS.bold}✓${COLORS.reset} ${COLORS.green}${message}${COLORS.reset}`,
  );
}

/**
 * Log an error message.
 */
export function error(message: string): void {
  console.error(
    `\n${COLORS.red}${COLORS.bold}✗${COLORS.reset} ${COLORS.red}${message}${COLORS.reset}`,
  );
}

/**
 * Log a warning message.
 */
export function warn(message: string): void {
  console.warn(
    `${COLORS.yellow}${COLORS.bold}⚠${COLORS.reset} ${COLORS.yellow}${message}${COLORS.reset}`,
  );
}
