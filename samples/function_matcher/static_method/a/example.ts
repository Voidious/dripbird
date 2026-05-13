class Logger {
    static formatMessage(level: string, message: string) {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] ${level}: ${message}`;
    }
}

class UserService {
    createUser(username: string) {
        db.insert("users", { username });
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] INFO: Created user ${username}`;
        console.log(logMsg);
    }

    deleteUser(username: string) {
        db.delete("users", { username });
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] INFO: Deleted user ${username}`;
        console.log(logMsg);
    }
}
