import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvitePanel } from "./InvitePanel";
import type { InviteView } from "../types";

/** The project screen's INVITE section (plan 2026-08-01-project-invites §1.8):
 *  project-scoped copy and project-carrying links, mint/revoke wired through.
 *
 *  Same house pattern as `SessionPicker.test.tsx` / `Header.test.tsx`: a REAL
 *  React render through `react-dom/server` for the markup (no DOM test env —
 *  `docs/tech-debt.md`), plus the hooks-shim tree walk to reach the `onClick`
 *  handlers static markup drops. `InvitePanel` takes everything as props —
 *  including `origin` — precisely so this file needs no `window`. */

/** Every line of DOM text the markup renders, in document order. */
const textLines = (markup: string): string[] =>
  markup
    .split(/<[^>]*>/)
    .map((chunk) =>
      chunk
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

/** Five and a half hours out — drift-safe for the same reason as
 *  InviteLanding.test.tsx (any reading in [300, 359] minutes floors to 5H). */
const invite = (over: Partial<InviteView> = {}): InviteView => ({
  id: "inv-1",
  token: "tok123",
  projectId: "acme",
  createdByName: "frank",
  expiresAt: Date.now() + 5.5 * 3600_000,
  uses: 1,
  maxUses: 10,
  ...over,
});

type PanelProps = Parameters<typeof InvitePanel>[0];

const baseProps = (over: Partial<PanelProps> = {}): PanelProps => ({
  projectId: "acme",
  projectName: "Acme Robotics",
  invites: [invite()],
  origin: "http://hub.local",
  onCreate: () => {},
  onRevoke: () => {},
  ...over,
});

const render = (over: Partial<PanelProps> = {}): string =>
  renderToStaticMarkup(<InvitePanel {...baseProps(over)} />);

/** Hooks-shim tree walk (Header.test.tsx pattern): `InvitePanel` uses no
 *  hooks, so calling it under the inert runtime yields its full host-node
 *  tree — the only way to reach an `onClick` that static markup drops. */
const H_KEY = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
type HostNode = { type: unknown; props: Record<string, unknown> };
const renderTree = (element: React.ReactElement): HostNode[] => {
  const internals = (React as unknown as Record<string, { H: unknown }>)[H_KEY];
  const prev = internals.H;
  internals.H = {
    useRef: (v: unknown) => ({ current: v }),
    useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}],
    useEffect: () => {},
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useContext: () => undefined,
  };
  try {
    const type = element.type as (props: unknown) => unknown;
    const rendered = type(element.props);
    const out: HostNode[] = [];
    const visit = (node: unknown) => {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const n = node as HostNode;
      if (n.props) { out.push(n); visit(n.props.children); }
    };
    visit(rendered);
    return out;
  } finally {
    internals.H = prev;
  }
};
const textOf = (node: unknown): string => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as HostNode;
  return n.props ? textOf(n.props.children) : "";
};
const button = (props: PanelProps, label: string): HostNode | undefined =>
  renderTree(<InvitePanel {...props} />).find(
    (n) => n.type === "button" && textOf(n).includes(label),
  );

describe("InvitePanel — project-scoped section (plan §1.8)", () => {
  it("states the project scope in the copy, with the project's display name", () => {
    expect(textLines(render())).toContain("anyone with this link can join Acme Robotics");
  });

  it("builds links carrying the project AND the token (plan §1.5)", () => {
    const markup = render();
    // The link rides a read-only input's `value`; `&` is entity-escaped in
    // markup, so the assertion spells it `&amp;`.
    expect(markup).toContain('value="http://hub.local/?project=acme&amp;invite=tok123"');
  });

  it("lists each invite with its minter and the shared seats/expiry labels", () => {
    const lines = textLines(render());
    expect(lines).toContain("· from frank");
    // React splits adjacent text expressions into separate chunks, so assert
    // on the rejoined text, not one line.
    expect(lines.join(" ")).toContain("9 SEATS LEFT · EXPIRES IN 5H");
  });

  it("reads NO ACTIVE INVITES when the list is empty", () => {
    expect(textLines(render({ invites: [] }))).toContain("NO ACTIVE INVITES");
  });

  it("CREATE fires onCreate and REVOKE fires onRevoke with the invite id", () => {
    const onCreate = vi.fn();
    const onRevoke = vi.fn();
    const props = baseProps({ onCreate, onRevoke });
    (button(props, "CREATE INVITE")!.props.onClick as () => void)();
    expect(onCreate).toHaveBeenCalledTimes(1);
    (button(props, "REVOKE")!.props.onClick as () => void)();
    expect(onRevoke).toHaveBeenCalledWith("inv-1");
  });
});
