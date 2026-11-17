export interface View {
  node: HTMLElement;
  destroy?: () => void;
  flush?: boolean;
}
