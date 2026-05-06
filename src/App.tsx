import { useEffect } from "react";
import { Topbar } from "./components/Topbar";
import { Hero } from "./components/Hero";
import { Building } from "./components/Building";
import { Activity } from "./components/Activity";
import { ExperienceList } from "./components/ExperienceList";
import { Skills } from "./components/Skills";

function SectionHead({
  num,
  kicker,
  title,
  meta,
  id,
}: {
  num: string;
  kicker: string;
  title: string;
  meta?: string;
  id: string;
}) {
  return (
    <header className="section-head">
      <div>
        <p className="section-eyebrow">
          <span className="num">{num}</span>
          {kicker}
        </p>
        <h2 id={id} className="section-title">
          {title}
        </h2>
      </div>
      {meta ? <p className="section-meta">{meta}</p> : null}
    </header>
  );
}

export function App() {
  // If someone deep-links to #education or #recognition (now nested inside
  // the experience > "where it started" fold), open the details and scroll.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash.slice(1);
      if (hash === "education" || hash === "recognition") {
        document
          .querySelectorAll<HTMLDetailsElement>(".earlier-roles")
          .forEach((d) => (d.open = true));
        requestAnimationFrame(() => {
          document.getElementById(hash)?.scrollIntoView({ behavior: "smooth" });
        });
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <Topbar />

      <main id="content">
        <div className="shell">
          <Hero />
        </div>

        <section className="section" id="building">
          <div className="shell">
            <SectionHead
              num="01"
              kicker="Shipped products · side projects · agent tooling"
              title="Recent work"
              id="building"
            />
            <Building />
          </div>
        </section>

        <section className="section" id="activity">
          <div className="shell">
            <SectionHead
              num="02"
              kicker="GitHub · last 12 months"
              title="Activity"
              id="activity"
            />
            <Activity />
          </div>
        </section>

        <section className="section" id="expertise">
          <div className="shell">
            <SectionHead
              num="03"
              kicker="What I work with"
              title="Expertise"
              id="expertise"
            />
            <Skills />
          </div>
        </section>

        <section className="section" id="experience">
          <div className="shell">
            <SectionHead
              num="04"
              kicker="Work history"
              title="Experience"
              meta="2008 — Present"
              id="experience"
            />
            <ExperienceList />
          </div>
        </section>

      </main>
    </>
  );
}
