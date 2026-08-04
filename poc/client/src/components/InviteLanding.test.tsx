import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteHero } from "./InviteLanding";
import type { InviteInfo } from "./InviteLanding";

/** The invite landing's loaded state (plan 2026-08-01-project-invites §1.6):
 *  inviter + PROJECT name — no session, because invites are project-scoped.
 *
 *  Same house pattern as `SessionPicker.test.tsx`: a REAL React render through
 *  `react-dom/server` — this repo has no DOM test environment and deliberately
 *  adds none (`docs/tech-debt.md`). `InviteLanding` itself opens a socket in
 *  `useEffect`, which a static render never runs, so the loaded state is
 *  asserted through the props-only `InviteHero` seam instead of being faked. */

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

/** Five and a half hours out: any whole-minute reading in [300, 359] floors
 *  to "EXPIRES IN 5H", so the label is stable against clock drift between
 *  fixture and render. */
const info = (): InviteInfo => ({
  projectId: "acme",
  projectName: "Acme Robotics",
  inviterName: "frank",
  expiresAt: Date.now() + 5.5 * 3600_000,
  remaining: 9,
});

const render = (over: Partial<Parameters<typeof InviteHero>[0]> = {}): string =>
  renderToStaticMarkup(
    <InviteHero info={info()} accepting={false} acceptError={null} onAccept={() => {}} {...over} />,
  );

describe("InviteHero — project-scoped landing copy (plan §1.6)", () => {
  it("names the inviter and the PROJECT — never a session", () => {
    const lines = textLines(render());
    expect(lines).toContain("FRANK INVITED YOU");
    expect(lines).toContain("Acme Robotics");
    // The old session-scoped landing rendered `{projectId} / {sessionId}`;
    // a regression back to it would put the raw id and a separator on screen.
    expect(lines).not.toContain("acme");
    expect(render()).not.toContain(" / ");
  });

  it("carries the shared seats/expiry line", () => {
    // React splits adjacent text expressions into separate chunks, so assert
    // on the rejoined text, not one line.
    expect(textLines(render()).join(" ")).toContain("EXPIRES IN 5H · 9 SEATS LEFT");
  });

  it("offers PRESS START while idle and JOINING… (disabled) once pressed", () => {
    expect(textLines(render())).toContain("PRESS START");
    const busy = render({ accepting: true });
    expect(textLines(busy)).toContain("JOINING…");
    expect(textLines(busy)).not.toContain("PRESS START");
    expect(busy).toContain("disabled=\"\"");
  });

  it("renders a redeem refusal inline and keeps PRESS START available", () => {
    // A failed token admits no one (plan §1.3): the landing stays, with the
    // server's failure text on a red line — no navigation, no dead end.
    const failed = render({ acceptError: "invite is full" });
    const lines = textLines(failed);
    expect(lines).toContain("invite is full");
    expect(lines).toContain("PRESS START");
    expect(failed).toMatch(/class="line red">invite is full/);
  });
});
