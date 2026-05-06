export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="page-foot">
      <p>References available on request.</p>
      <p className="muted">© {year} Jetz Alipalo</p>
    </footer>
  );
}
