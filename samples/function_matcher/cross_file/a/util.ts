export function sendGreeting(connection) {
    connection.send("Hello,");
    connection.send("I am from Earth.");
    connection.send("We come in peace.");
}
