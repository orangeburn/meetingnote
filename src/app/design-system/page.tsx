import { AppFrame, Button, PageContainer, PanelHeader, SectionHeading } from "@/design-system/primitives";
import { designFoundations } from "@/design-system/foundations";

export default function DesignSystemPage() {
  const palette = [
    ["canvas", designFoundations.color.canvas],
    ["panel", designFoundations.color.panel],
    ["line", designFoundations.color.line],
    ["text", designFoundations.color.text],
    ["muted", designFoundations.color.muted],
    ["accent", designFoundations.color.accent],
  ] as const;

  return (
    <AppFrame>
      <PageContainer className="py-4">
        <header className="saas-header-floating">
          <div className="saas-header-left">
            <p className="eyebrow">Design System</p>
            <h1 className="saas-header-title">{designFoundations.identity.name}</h1>
          </div>
        </header>

        <div className="saas-shell">
          <aside className="saas-sidebar">
            <div className="saas-sidebar-head">
              <p className="panel-kicker">Foundations</p>
              <h2 className="panel-title">Token Sets</h2>
            </div>
            <div className="saas-history-list">
              <article className="saas-history-item saas-history-item-active">
                <div className="saas-history-row">
                  <span className="saas-history-main">Colors</span>
                  <span className="task-state-pill">Core</span>
                </div>
                <div className="saas-history-row saas-history-row-meta">
                  <span>Neutral-first palette</span>
                </div>
              </article>
              <article className="saas-history-item">
                <div className="saas-history-row">
                  <span className="saas-history-main">Typography</span>
                  <span className="task-state-pill">IBM Plex Sans</span>
                </div>
                <div className="saas-history-row saas-history-row-meta">
                  <span>Compact hierarchy</span>
                </div>
              </article>
              <article className="saas-history-item">
                <div className="saas-history-row">
                  <span className="saas-history-main">Layout</span>
                  <span className="task-state-pill">SaaS</span>
                </div>
                <div className="saas-history-row saas-history-row-meta">
                  <span>Floating header + split body</span>
                </div>
              </article>
            </div>
          </aside>

          <section className="saas-main">
            <SectionHeading
              compact
              eyebrow="Reference"
              title="当前落地规范"
              description="以工具界面为目标：纯色底、单层容器、清晰边框、紧凑控件。"
              actions={<span className="task-state-pill">v1.0</span>}
            />

            <section className="saas-section">
              <PanelHeader eyebrow="Color" title="Core Palette" />
              <div className="saas-detail-grid">
                {palette.map(([name, value]) => (
                  <div key={name} className="saas-detail-item">
                    <span>{name}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="saas-section">
              <PanelHeader eyebrow="Components" title="Control Rules" />
              <div className="saas-detail-grid">
                <div className="saas-detail-item">
                  <span>Button Height</span>
                  <strong>32px / 28px (sm)</strong>
                </div>
                <div className="saas-detail-item">
                  <span>Card Layer</span>
                  <strong>Single-layer in body</strong>
                </div>
                <div className="saas-detail-item">
                  <span>Corner Radius</span>
                  <strong>12 / 8 / 6</strong>
                </div>
                <div className="saas-detail-item">
                  <span>Decoration</span>
                  <strong>No gradient</strong>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button tone="primary" size="sm">
                  Primary
                </Button>
                <Button tone="secondary" size="sm">
                  Secondary
                </Button>
                <Button tone="ghost" size="sm">
                  Ghost
                </Button>
              </div>
            </section>
          </section>
        </div>
      </PageContainer>
    </AppFrame>
  );
}
