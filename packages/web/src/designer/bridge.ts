/**
 * The link between the designer's canvas and the assistant's panel (task 9.65). The designer
 * registers itself here while it is on the page; the assistant reads the canvas through it when a
 * question is asked and puts a changed workflow on it. A change arrives the same way as one made
 * by hand: it lands on the canvas and the designer's autosave stores it.
 */
export interface DesignerBridge {
  /** The canvas as it would be saved now (valid or not), and the workflow's folder as typed. */
  snapshot(): { definition: any; baseDir: string };
  /** Put a workflow on the canvas. Steps that have no position keep the one they have on the canvas, or are placed beside the others. */
  apply(definition: any, note: string): void;
}

let current: DesignerBridge | null = null;

export const designerBridge = {
  get: () => current,
  set(b: DesignerBridge | null) { current = b; },
};
