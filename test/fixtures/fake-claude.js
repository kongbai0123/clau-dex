if (process.argv.includes("--version")) {
  console.log("fake-claude 1.0");
} else {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (process.argv[process.argv.indexOf("--input-format") + 1] === "stream-json") {
    const message = JSON.parse(input.trim());
    input = message.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  }
  console.log(JSON.stringify({
    result: JSON.stringify({
      message: "fake delegated result",
      input,
      args: process.argv.slice(2),
    }),
  }));
}
