import { profile } from "../data/resume";

function handlePrint() {
  document
    .querySelectorAll<HTMLDetailsElement>("details")
    .forEach((d) => (d.open = true));
  window.print();
}

export function Topbar() {
  return (
    <header className="topbar">
      <div className="shell topbar-inner">
        <a href="#top" className="brand" aria-label={profile.name}>
          <span className="brand-mark" aria-hidden="true">
            <span className="brand-prompt">&gt;</span>
            <span className="brand-cursor">_</span>
          </span>
          {profile.name}
        </a>

        <nav className="topbar-nav" aria-label="Sections">
          <a href="#building">Work</a>
          <a href="#activity">Activity</a>
          <a href="#expertise">Expertise</a>
          <a href="#experience">Experience</a>
        </nav>

        <button type="button" className="topbar-cta" onClick={handlePrint}>
          Download CV
          <span aria-hidden="true" className="arrow"> ↓</span>
        </button>
      </div>
    </header>
  );
}
