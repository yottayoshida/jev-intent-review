export interface ButtonOptions {
  disabled?: boolean;
  kind?: "primary" | "secondary";
}

export function renderButton(label: string, options: ButtonOptions = {}): string {
  const disabled = options.disabled ? " disabled" : "";
  return `<button class="${options.kind ?? "primary"}"${disabled}>${label}</button>`;
}
