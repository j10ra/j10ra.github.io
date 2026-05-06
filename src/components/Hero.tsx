import { Suspense, lazy } from "react";
import { profile, stats } from "../data/resume";

const Backdrop = lazy(() => import("./Backdrop"));

function handlePrint() {
  document
    .querySelectorAll<HTMLDetailsElement>("details")
    .forEach((d) => (d.open = true));
  window.print();
}

export function Hero() {
  return (
    <section className="hero" id="top">
      <Suspense fallback={null}>
        <Backdrop />
      </Suspense>
      <div className="hero-fade" aria-hidden="true" />

      <div className="hero-content">
        <p className="eyebrow">Curriculum vitae · 2026</p>

        <h1 className="display">{profile.name}</h1>

        <div className="role-tag">
          <span className="pill">Selectively booking</span>
          {profile.role} · {profile.location}
        </div>

        <p className="lede">{profile.lede}</p>

        <div className="hero-actions">
          <a className="btn btn--primary" href={`mailto:${profile.email}`}>
            Get in touch <span className="arrow">→</span>
          </a>
          <button className="btn" type="button" onClick={handlePrint}>
            Download CV <span className="arrow">↓</span>
          </button>
          {profile.links.map((l) => (
            <a
              key={l.href}
              className="btn"
              href={l.href}
              target="_blank"
              rel="noreferrer"
            >
              {l.label} <span className="arrow">↗</span>
            </a>
          ))}
        </div>

        <dl className="stats" aria-label="At a glance">
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="stat-num">{s.value}</dt>
              <dd className="stat-lbl">{s.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
