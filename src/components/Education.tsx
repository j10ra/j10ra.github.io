import { education } from "../data/resume";

export function Education() {
  return (
    <div className="timeline">
      {education.map((e, i) => (
        <article key={i} className="entry">
          <span className="entry-rail" aria-hidden="true" />
          <aside className="entry-aside">
            <p className="entry-period">{e.period}</p>
          </aside>
          <div className="entry-main">
            <h3 className="entry-title">
              {e.title}
              <span className="at"> · </span>
              <span>{e.company}</span>
            </h3>
            <p className="entry-summary">{e.summary}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
