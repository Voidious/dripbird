class Logger {
    static formatMessage(level: string, message: string) {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] ${level}: ${message}`;
    }
}

class UserService {
    createUser(username: string) {
        db.insert("users", { username });
        console.log(Logger.formatMessage("INFO", `Created user ${username}`));
    }

    deleteUser(username: string) {
        db.delete("users", { username });
        console.log(Logger.formatMessage("INFO", `Deleted user ${username}`));
    }
}
