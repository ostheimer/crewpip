import { Fragment } from "react";
import { ArrowRight } from "lucide-react";
import type { ConnectionState } from "@crewpip/shared";
import { useBoardLanguage } from "./language.tsx";

const STATES: ConnectionState[] = ["connected", "no-hook", "restart-needed", "stale", "ended"];

/** `code` in Erklärtexten als <code> ausgeben, sonst reiner Text. */
export function Rich({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>)}</>;
}

/** Bildliche Darstellung: zwei Chats, CrewPip dazwischen, keine direkte Verbindung. */
export function MessageFlow() {
  const { ui } = useBoardLanguage();
  const f = ui.guide.flow;
  return <figure className="flow-diagram" role="img" aria-label={ui.guide.flowLabel}>
    <div className="flow-row">
      <div className="flow-node"><strong>{f.sender}</strong><small>{f.senderApp}</small></div>
      <div className="flow-arrow"><span>{f.leave}</span></div>
      <div className="flow-node flow-hub"><strong>{f.hub}</strong><small>{f.hubSub}</small></div>
      <div className="flow-arrow"><span>{f.fetch}</span></div>
      <div className="flow-node"><strong>{f.receiver}</strong><small>{f.receiverApp}</small></div>
    </div>
    <p className="flow-nodirect"><span aria-hidden="true">✕</span> {f.sender} ↔ {f.receiver}: {f.noDirect}</p>
  </figure>;
}

export function Guide({ onWrite, onTasks }: { onWrite: (target: string) => void; onTasks: () => void }) {
  const { ui } = useBoardLanguage();
  const g = ui.guide;
  return <div className="guide">
    <section className="guide-section"><h2>{g.flowTitle}</h2><MessageFlow /></section>
    <section className="guide-section"><h2>{g.partsTitle}</h2>
      <div className="guide-parts">{g.parts.map(([title, text]) => <article key={title}><h3>{title}</h3><p><Rich text={text} /></p></article>)}</div>
    </section>
    <section className="guide-section"><h2>{g.pathsTitle}</h2><p>{g.pathsIntro}</p>
      <div className="table-scroll"><table className="guide-table">
        <thead><tr>{g.pathsHead.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{g.paths.map(([path, ...cells]) => <tr key={path}><th scope="row">{path}</th>{cells.map((c, i) => <td key={i}><Rich text={c} /></td>)}</tr>)}</tbody>
      </table></div>
    </section>
    <section className="guide-section"><h2>{g.addressesTitle}</h2><p>{g.addressesIntro}</p>
      <dl className="guide-list">{g.addresses.map(([address, text]) => <div key={address}><dt><code>{address}</code></dt><dd><Rich text={text} /></dd></div>)}</dl>
    </section>
    <section className="guide-section"><h2>{g.statesTitle}</h2><p><Rich text={g.statesIntro} /></p>
      <dl className="guide-list">{STATES.map(state => <div key={state}><dt>{ui.connectionState[state]}</dt><dd><Rich text={g.states[state]} /></dd></div>)}</dl>
      <h3>{g.fixTitle(ui.connectionState["no-hook"])}</h3><ol>{g.fix(ui.connectionState.connected).map(step => <li key={step}><Rich text={step} /></li>)}</ol>
    </section>
    <section className="guide-section"><h2>{g.limitsTitle}</h2>
      <dl className="guide-list">{g.limits.map(([title, text]) => <div key={title}><dt>{title}</dt><dd><Rich text={text} /></dd></div>)}</dl>
    </section>
    <section className="guide-section"><h2>{g.startTitle}</h2>
      <div className="guide-grid">
        <article><span className="step-number">1</span><h3>{ui.setGoalTitle}</h3><p>{ui.goalExample}</p><button className="primary" onClick={() => onWrite("director")}>{ui.writeDirector} <ArrowRight size={16} /></button></article>
        <article><span className="step-number">2</span><h3>{ui.recordWork}</h3><p>{ui.taskGuide}</p><button className="secondary" onClick={onTasks}>{ui.planTask} <ArrowRight size={16} /></button></article>
        <article><span className="step-number">3</span><h3>{ui.reviewResults}</h3><p>{ui.reviewGuide}</p><button className="secondary" onClick={onTasks}>{ui.viewTasks} <ArrowRight size={16} /></button></article>
      </div>
      <section className="help-panel"><p>{ui.localGuide}</p><p>{ui.worktreeGuide}</p></section>
    </section>
  </div>;
}
