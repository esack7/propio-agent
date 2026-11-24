import { withMcpLogin } from "../mcp/login.js";

test("callback binds state and closes after success", async () => {
  let redirect = "";
  await withMcpLogin(
    async (interaction, signal) => {
      redirect = interaction.redirectUrl;
      const url = new URL("http://127.0.0.1/authorize?state=expected");
      await expect(interaction.authorize(url, signal)).resolves.toEqual({
        code: "synthetic-code",
        state: "expected",
      });
    },
    async () => {
      expect((await fetch(`${redirect}?state=wrong&code=bad`)).status).toBe(
        400,
      );
      await fetch(`${redirect}?state=expected&code=synthetic-code`);
    },
  );
  await expect(fetch(redirect)).rejects.toThrow();
});

test("cancelled login releases callback", async () => {
  const controller = new AbortController();
  let redirect = "";
  await expect(
    withMcpLogin(
      async (interaction, signal) => {
        redirect = interaction.redirectUrl;
        return interaction.authorize(
          new URL("http://127.0.0.1/authorize?state=expected"),
          signal,
        );
      },
      async () => {
        controller.abort();
      },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  await expect(fetch(redirect)).rejects.toThrow();
});
