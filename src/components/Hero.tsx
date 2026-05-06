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
        <p className="eyebrow">README · 2026</p>

        <h1 className="display">{profile.name}</h1>

        <div className="role-tag">
          <span
            className="pill pill--icon"
            role="img"
            aria-label="Selectively booking"
            title="Selectively booking"
          >
            <svg viewBox="0 0 14 18" aria-hidden="true" focusable="false">
              <path d="M8.4 0 0 10.2h4.6L3.2 18 14 7.4H8.6L10 0z" />
            </svg>
          </span>
          {profile.role} · {profile.location}
        </div>

        <p className="lede">{profile.lede}</p>

        <p className="print-contact print-only" aria-hidden="true">
          {profile.email} · {profile.phone} · {profile.location}
          {profile.links
            .filter((l) => l.label.toLowerCase() !== "github")
            .map((l) => ` · ${l.href.replace(/^https?:\/\//, "")}`)}
        </p>

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
