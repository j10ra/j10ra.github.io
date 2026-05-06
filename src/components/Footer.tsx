import { profile } from "../data/resume";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="page-foot">
      <span>
        © {year} · {profile.name}
      </span>
      <a href="#top" className="page-foot-link">
        Back to top ↑
      </a>
    </footer>
  );
}
