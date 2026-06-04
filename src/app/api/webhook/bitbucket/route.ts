export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.text();
  console.log("[bitbucket-webhook] payload：", body);
  return new Response("OK", { status: 200 });
}