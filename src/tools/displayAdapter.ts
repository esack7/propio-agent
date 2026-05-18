export interface ToolDisplayAdapter {
  renderUse(input: Partial<Record<string, unknown>>): string | null;
  renderResult(result: string, input: Record<string, unknown>): string | null;
  renderError?(error: unknown, input?: Partial<Record<string, unknown>>): string | null;
}
