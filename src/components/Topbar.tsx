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
          <span className="brand-dot" aria-hidden="true" />
          {profile.name}
        </a>

        <nav className="topbar-nav" aria-label="Sections">
          <a href="#building">Building</a>
          <a href="#activity">Activity</a>
          <a href="#experience">Experience</a>
          <a href="#expertise">Expertise</a>
        </nav>

        <button type="button" className="topbar-cta" onClick={handlePrint}>
          Download CV
          <span aria-hidden="true" className="arrow"> ↓</span>
        </button>
      </div>
    </header>
  );
}
