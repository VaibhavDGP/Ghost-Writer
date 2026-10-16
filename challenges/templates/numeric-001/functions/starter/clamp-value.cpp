int clampValue(int value, int lower, int upper) {
    if (value < lower) {
        return upper; // Intentional bug: should return lower
    }
    if (value > upper) {
        return upper;
    }
    return value;
}