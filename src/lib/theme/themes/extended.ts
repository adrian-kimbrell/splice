import classic from "./extended/classic";
import modern from "./extended/modern";
import community from "./extended/community";

// Merged export — consumers see all 55 themes under one object.
// Data is split into three sub-files (~27 KB each) to keep individual files manageable.
const themes = { ...classic, ...modern, ...community };

export default themes;
