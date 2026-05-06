import { awards } from "../data/resume";

export function Awards() {
  return (
    <ul className="awards">
      {awards.map((a, i) => (
        <li key={i}>
          <span className="meta">{a.year}</span>
          <span>
            <strong>{a.title}</strong>
            <span className="muted"> — {a.body}</span>
            {a.org ? (
              <span className="muted">
                {" · "}
                {a.orgHref ? (
                  <a href={a.orgHref} target="_blank" rel="noreferrer">
                    {a.org}
                  </a>
                ) : (
                  a.org
                )}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
