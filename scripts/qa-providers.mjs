import { createServer } from "node:http";
const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  res.setHeader("content-type", "application/json");
  if (req.url?.endsWith("/chat/completions")) {
    // Connection tests: a bad key or unknown model fails the way a real provider does.
    if (req.headers.authorization === "Bearer qa-bad-key") {
      res.statusCode = 401;
      res.end(
        JSON.stringify({ error: { message: "Incorrect API key provided." } }),
      );
      return;
    }
    if (body.model === "qa-missing-model") {
      res.statusCode = 404;
      res.end(
        JSON.stringify({ error: { message: "The model does not exist." } }),
      );
      return;
    }
    let data;
    try {
      data = JSON.parse(body.messages.at(-1).content);
    } catch {
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
      return;
    }
    // Fault injection for the stress test: the user's note selects how the "provider" misbehaves.
    const fault = /qa-fault:([\w-]+)/.exec(data.user_note ?? "")?.[1];
    if (fault === "analyst-500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
      return;
    }
    if (fault === "analyst-garbage") {
      res.end(JSON.stringify({ choices: [{ message: { content: "I think you should add an index." } }] }));
      return;
    }
    if (fault === "analyst-truncated") {
      res.end(JSON.stringify({ choices: [{ message: { content: '{"candidates":[{"key":"idx","title":"Cov' } }] }));
      return;
    }
    if (fault === "analyst-one-option") {
      res.end(JSON.stringify({ choices: [{ message: { content: '{"candidates":[],"insufficient_evidence":"Need an actual plan."}' } }] }));
      return;
    }
    const ids = data.digest.evidence.map((e) => e.id);
    const options = [
      {
        key: "review_statistics",
        title: "Review and refresh stale statistics",
        diagnosis:
          "The selected statement has a large estimate mismatch that warrants checking statistics freshness.",
        option_type: "statistics",
        sql_to_run: "UPDATE STATISTICS [Sales].[Orders];",
        expected:
          "Better cardinality estimates may improve the chosen join and access methods.",
      },
      {
        key: "measure_baseline",
        title: "Capture a representative runtime baseline",
        diagnosis:
          "The plan alone cannot establish current production runtime or prove the cause of the regression.",
        option_type: "ops",
        sql_to_run: null,
        expected:
          "Compare logical reads, CPU, duration, and result equivalence before making a change.",
      },
    ].map((o) => ({
      ...o,
      actions: [
        {
          title:
            o.key === "review_statistics"
              ? "Verify statistics freshness"
              : "Measure the baseline",
          detail:
            "Use a representative test workload and capture the actual execution plan.",
          effort: "low",
          requires_change_control: o.option_type === "statistics",
        },
      ],
      evidence_ids: [ids[0]],
      prerequisites: [
        "Confirm the target database and a representative parameter set.",
      ],
      validation: [
        "Compare result rows, logical reads, CPU, and duration before and after.",
      ],
      rollback: [
        "Restore the original deployment and reviewed configuration if validation fails.",
      ],
    }));
    await new Promise((r) =>
      setTimeout(r, data.user_note?.includes("qa slow") ? 5000 : 200),
    );
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ candidates: options }) } },
        ],
      }),
    );
    return;
  }
  if (req.url?.endsWith("/models") && req.method === "GET") {
    res.end(
      JSON.stringify({
        data: [{ id: "qa-controlled-model" }, { id: "qa-original" }],
      }),
    );
    return;
  }
  if (req.url === "/v1/systemone") {
    const jevFault = /qa-fault:([\w-]+)/.exec(body.state?.constraints ?? "")?.[1];
    if (jevFault === "jev-500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "jev down" } }));
      return;
    }
    if (jevFault === "jev-slow") await new Promise((r) => setTimeout(r, 25_000));
    if (req.headers.authorization === "Bearer qa-bad-key") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: "Invalid API key." } }));
      return;
    }
    const answers = {};
    for (const [key, q] of Object.entries(body.questions)) {
      if (key === "first_to_run")
        answers[key] = {
          type: "choice",
          choice: "review_statistics",
          confidence: 0.87,
          probabilities: {
            review_statistics: 0.87,
            measure_baseline: 0.08,
            no_suitable_action: 0.05,
          },
        };
      else if (
        q.type === "noul" ||
        [
          "root_cause",
          "anything_worth_running",
          "evidence_supported",
          "operational_safe",
        ].includes(key)
      )
        answers[key] = { type: "noul", noul: 0.9 };
      else
        answers[key] = {
          type: "score",
          score: key === "ease" ? 3 : 3.5,
          confidence: 0.85,
          legend: {},
          probabilities: {},
        };
    }
    res.end(
      JSON.stringify({
        model: "qa-controlled",
        usage: { input_tokens: 10, output_tokens: 10 },
        answers,
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
server.listen(18889, "127.0.0.1");
