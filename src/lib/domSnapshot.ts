import type { Page } from 'playwright';

export interface ControlDescriptor {
  tag: string;
  id?: string;
  name?: string;
  indexAmongSameTag: number;
}

export interface SnapshotInput {
  selector: string;
  type: string;
  id?: string;
  name?: string;
  ariaLabel?: string;
  placeholder?: string;
}

export interface SnapshotButton {
  selector: string;
  text: string;
}

export interface FormControlSnapshot {
  inputs: SnapshotInput[];
  buttons: SnapshotButton[];
}

/**
 * Pure: synthesizes a verifiable CSS selector for one control, preferring `#id`, then
 * `tag[name="..."]`, then a structural `tag:nth-of-type(n)` fallback — so every selector
 * handed to Claude for the ATS bootstrap step is guaranteed to resolve to a real element on
 * the page, never just descriptive text.
 */
export function buildSelector(descriptor: ControlDescriptor): string {
  if (descriptor.id) return `#${descriptor.id}`;
  if (descriptor.name) return `${descriptor.tag}[name="${descriptor.name}"]`;
  return `${descriptor.tag}:nth-of-type(${descriptor.indexAmongSameTag + 1})`;
}

interface RawDescriptor extends ControlDescriptor {
  type?: string;
  ariaLabel?: string;
  placeholder?: string;
  text?: string;
}

/**
 * Extracts every input/select/textarea and every clickable button/link on the live page,
 * synthesizing a verifiable selector for each via `buildSelector`.
 */
export async function snapshotFormControls(page: Pick<Page, 'evaluate'>): Promise<FormControlSnapshot> {
  const raw = await page.evaluate(() => {
    function describe(el: Element, tag: string, index: number) {
      const input = el as HTMLInputElement;
      return {
        tag,
        id: el.id || undefined,
        name: input.name || undefined,
        type: input.type || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        placeholder: input.placeholder || undefined,
        text: el.textContent?.trim() || undefined,
        indexAmongSameTag: index,
      };
    }

    const inputEls = Array.from(document.querySelectorAll('input, select, textarea'));
    const inputTagCounts: Record<string, number> = {};
    const inputs = inputEls.map((el) => {
      const tag = el.tagName.toLowerCase();
      const count = inputTagCounts[tag] ?? 0;
      inputTagCounts[tag] = count + 1;
      return describe(el, tag, count);
    });

    const buttonEls = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    const buttonTagCounts: Record<string, number> = {};
    const buttons = buttonEls.map((el) => {
      const tag = el.tagName.toLowerCase();
      const count = buttonTagCounts[tag] ?? 0;
      buttonTagCounts[tag] = count + 1;
      return describe(el, tag, count);
    });

    return { inputs, buttons };
  });

  const rawInputs = raw.inputs as RawDescriptor[];
  const rawButtons = raw.buttons as RawDescriptor[];

  return {
    inputs: rawInputs.map((d) => ({
      selector: buildSelector(d),
      type: d.type ?? 'text',
      id: d.id,
      name: d.name,
      ariaLabel: d.ariaLabel,
      placeholder: d.placeholder,
    })),
    buttons: rawButtons.map((d) => ({ selector: buildSelector(d), text: d.text ?? '' })),
  };
}
