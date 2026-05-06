import { Fragment } from "react";
import { experience, profile, type Role } from "../data/resume";
import { Education } from "./Education";
import { Awards } from "./Awards";

const PRIMARY_COUNT = 3;

function Entry({ role }: { role: Role }) {
  const summary = Array.isArray(role.summary)
    ? role.summary
    : role.summary
      ? [role.summary]
      : [];
  const lead = summary[0];
  const restSummary = summary.slice(1);
  const hasDetails =
    restSummary.length > 0 || (role.bullets?.length ?? 0) > 0;

  return (
    <article className="entry">
      <span className="entry-rail" aria-hidden="true" />

      <aside className="entry-aside">
        <p className="entry-period">{role.period}</p>
        {role.location ? <p className="entry-loc">{role.location}</p> : null}
      </aside>

      <div className="entry-main">
        <h3 className="entry-title">
          {role.title}
          <span className="at"> · </span>
          {role.href ? (
            <a href={role.href} target="_blank" rel="noreferrer">
              {role.company}
            </a>
          ) : (
            <span>{role.company}</span>
          )}
        </h3>

        {lead ? <p className="entry-summary">{lead}</p> : null}

        {hasDetails ? (
          <details className="expand">
            <summary>
              <span className="summary-label">View details</span>
              <span className="summary-icon" aria-hidden="true">+</span>
            </summary>
            <div className="expand-body">
              {restSummary.map((p, idx) => (
                <p key={idx} className="entry-summary">
                  {p}
                </p>
              ))}

              {role.bullets?.length ? (
                <ul className="entry-bullets">
                  {role.bullets.map((b, idx) =>
                    typeof b === "string" ? (
                      <li key={idx}>{b}</li>
                    ) : (
                      <li key={idx}>
                        {b.text}
                        {b.sub?.length ? (
                          <ul>
                            {b.sub.map((s, sIdx) => (
                              <li key={sIdx}>{s}</li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    )
                  )}
                </ul>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

export function ExperienceList() {
  const primary = experience.slice(0, PRIMARY_COUNT);
  const earlier = experience.slice(PRIMARY_COUNT);

  return (
    <div className="timeline">
      {primary.map((role, i) => (
        <Entry key={i} role={role} />
      ))}

      {earlier.length > 0 ? (
        <div className="bottom-strip">
          <details className="earlier-roles">
            <summary>
              <span className="earlier-label">Where it started</span>
              <span className="earlier-period muted">
                From 2006 · earlier roles, education, recognition
              </span>
              <span className="summary-icon" aria-hidden="true">+</span>
            </summary>
            <div className="earlier-body">
              {earlier.map((role, i) => (
                <Fragment key={i}>
                  <Entry role={role} />
                </Fragment>
              ))}

              <section className="earlier-aside" id="education">
                <p className="earlier-aside-label">Education</p>
                <Education />
              </section>

              <section className="earlier-aside" id="recognition">
                <p className="earlier-aside-label">Recognition</p>
                <Awards />
              </section>
            </div>
          </details>

          <div className="collapsed-end">
            © {new Date().getFullYear()} · {profile.name}
          </div>

          <div className="bottom-end">
            <span>
              © {new Date().getFullYear()} · {profile.name}
            </span>
            <a href="#top">Back to top ↑</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
