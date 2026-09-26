/** The Vonage application's answer URL. No number is linked to this application, so no inbound call should ever
 *  arrive; if one does, it is told so and ended. Outbound recall calls carry their own inline NCCO. */
export async function GET() {
  return Response.json([{ action: "talk", text: "This number does not take calls. Goodbye.", language: "en-US" }]);
}
