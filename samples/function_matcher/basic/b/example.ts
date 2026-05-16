function sendWelcomeEmail(recipient: string) {
    const subject = "Welcome!";
    const body = `Hello ${recipient}, thanks for signing up.`;
    smtp.send(recipient, subject, body);
}

function registerUser(username: string, email: string) {
    db.insert("users", { username, email });
    sendWelcomeEmail(email);
}
