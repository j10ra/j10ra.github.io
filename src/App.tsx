import { Topbar } from "./components/Topbar";
import { Hero } from "./components/Hero";
import { Building } from "./components/Building";
import { Activity } from "./components/Activity";
import { ExperienceList } from "./components/ExperienceList";
import { Skills } from "./components/Skills";
import { Education } from "./components/Education";
import { Awards } from "./components/Awards";
import { Footer } from "./components/Footer";

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
              kicker="Side projects · agent tooling"
              title="Currently building"
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

        <section className="section" id="experience">
          <div className="shell">
            <SectionHead
              num="03"
              kicker="Work history"
              title="Experience"
              meta="2008 — Present"
              id="experience"
            />
            <ExperienceList />
          </div>
        </section>

        <section className="section" id="expertise">
          <div className="shell">
            <SectionHead
              num="04"
              kicker="What I work with"
              title="Expertise"
              id="expertise"
            />
            <Skills />
          </div>
        </section>

        <section className="section" id="education">
          <div className="shell">
            <SectionHead
              num="05"
              kicker="Background"
              title="Education"
              id="education"
            />
            <Education />
          </div>
        </section>

        <section className="section" id="recognition">
          <div className="shell">
            <SectionHead
              num="06"
              kicker="Selected awards"
              title="Recognition"
              id="recognition"
            />
            <Awards />
          </div>
        </section>

        <div className="shell">
          <Footer />
        </div>
      </main>
    </>
  );
}
