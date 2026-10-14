// Only explicit page messages determine a terminal state. The shared
// "Return to home screen" button appears on both rejection and end pages.
export function classifyMeetPage(text) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (/check your meeting code|invalid video call name|meeting code.*(?:invalid|expired)|проверьте код встречи|недействител[ье]н.*код/i.test(body)) return "invalid_meeting";
  if (/your request to join was denied|request.*denied|organizer.*denied|вам отказали|запрос.*отклон[её]н/i.test(body)) return "denied";
  if (/no one responded to your request to join|никто не ответил на.*запрос/i.test(body)) return "waiting_timeout";
  if (/sign in to join|you need to sign in|войдите.*(?:присоединиться|участвовать)|требуется.*войти/i.test(body)) return "auth_required";
  if (/you can['’]t join this video call|not allowed to join|не удалось присоединиться к видеовстрече|вы не можете присоединиться/i.test(body)) return "join_rejected";
  if (/asking to be let in|someone in the call will let you in soon|waiting for someone to let you in|please wait until (?:a |the )?meeting host brings you into the call|подождите.*организатор.*запрос|дождитесь.*организатор|ожидайте.*организатор|скоро кто-нибудь из участников разрешит вам войти/i.test(body)) return "waiting_room";
  if (/you left the meeting|you['’]ve left the call|video call ended|meeting has ended|вы покинули встречу|видеозвонок заверш[её]н|встреча завершена/i.test(body)) return "meeting_ended";
  return null;
}

export const MEET_ERRORS = Object.freeze({
  invalid_meeting: "Google Meet: код встречи недействителен или истёк. Нужна действующая ссылка организатора.",
  denied: "Google Meet: организатор отклонил запрос на вход бота.",
  waiting_timeout: "Google Meet: организатор не подтвердил запрос на вход за отведённое время.",
  auth_required: "Google Meet требует входа в Google-аккаунт. Выполните вход в аккаунт бота или попросите организатора разрешить гостевые подключения. Запись не началась.",
  join_rejected: "Google Meet отклонил подключение (You can't join this video call). Проверьте, что организатор находится во встрече и разрешил вход гостям или аккаунту бота. Запись не началась.",
  meeting_ended: "Встреча в Google Meet завершена.",
});
