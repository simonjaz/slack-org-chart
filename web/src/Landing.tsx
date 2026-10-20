export function Landing() {
  return (
    <main className="landing">
      <h1>Org Chart for Slack</h1>
      <p>
        See who works with whom, right from Slack. Org Chart reads names, titles, photos and the Manager field
        from your workspace and draws the reporting tree, starting from you. Guests and people from other
        companies are clearly marked.
      </p>
      <a className="button primary" href="/slack/install">
        Add to Slack
      </a>
      <p className="muted">
        Already installed? <a href="/chart">Open the chart</a>.
      </p>
    </main>
  );
}
