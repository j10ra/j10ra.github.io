import { building } from "../data/resume";

export function Building() {
  const [featured, ...rest] = building;

  return (
    <div className="projects">
      <article className="project project--featured">
        <header className="project-head">
          <div>
            <p className="project-kicker">Featured project</p>
            <h3 className="project-name">
              {featured.href ? (
                <a href={featured.href} target="_blank" rel="noreferrer">
                  {featured.name}
                  <span aria-hidden="true" className="arrow"> ↗</span>
                </a>
              ) : (
                featured.name
              )}
            </h3>
          </div>
          <span className="project-status">{featured.status}</span>
        </header>
        <p className="project-blurb project-blurb--lg">{featured.blurb}</p>
        <ul className="tags">
          {featured.tags.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </article>

      <div className="projects-side">
        {rest.map((p) => (
          <article key={p.name} className="project">
            <header className="project-head">
              <h3 className="project-name">
                {p.href ? (
                  <a href={p.href} target="_blank" rel="noreferrer">
                    {p.name}
                    <span aria-hidden="true" className="arrow"> ↗</span>
                  </a>
                ) : (
                  p.name
                )}
              </h3>
              <span className="project-status">{p.status}</span>
            </header>
            <p className="project-blurb">{p.blurb}</p>
            <ul className="tags">
              {p.tags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  );
}
