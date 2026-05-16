function processUser(user: { active: boolean; name: string }) {
    if (user.active) {
        console.log("User is active");
        enableAccount(user);
    } else {
        console.log("User is inactive");
        disableAccount(user);
    }
}
