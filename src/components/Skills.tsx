import { skills, practice, aiStack } from "../data/resume";

export function Skills() {
  return (
    <div className="expertise">
      <div className="skill-card featured">
        <div className="skill-card-meta">
          <p className="skill-label">{aiStack.label}</p>
          <span className="skill-pill">Daily driver</span>
        </div>
        <ul className="tags">
          {aiStack.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
        <p className="prose">
          Built and maintain custom MCP servers and coding-agent skill suites
          that fold multi-step investigation work into single agent calls.
          Fully self-equipped — frontier model subscriptions, custom toolkit,
          and a self-hosted inference VM. The kit travels with me.
        </p>
      </div>

      <div className="skills">
        {skills.map((g) => (
          <div className="skill-card" key={g.label}>
            <p className="skill-label">{g.label}</p>
            <ul className="tags">
              {g.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="skill-card practice-card">
        <p className="skill-label">Practice</p>
        <p className="prose">{practice}</p>
      </div>
    </div>
  );
}
