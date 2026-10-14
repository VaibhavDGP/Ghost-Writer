#include <iostream>

int calculateDiscountPercent(int subtotal) {
    if (subtotal >= 1000) {
        return 20;
    }

    if (subtotal >= 500) {
        return 10;
    }

    return 0;
}

int calculateShippingCost(int subtotal) {
    if (subtotal >= 800) {
        return 0;
    }

    return 50;
}

int calculateTax(int taxableAmount) {
    return (taxableAmount * 8) / 100;
}

int calculateDiscountAmount(int subtotal, int discountPercent) {
    return (subtotal * discountPercent) / 100;
}

int calculateTotal(
    int subtotal,
    int discountAmount,
    int tax,
    int shippingCost
) {
    const int discountedSubtotal = subtotal - discountAmount;
    return discountedSubtotal + tax + shippingCost;
}

int main() {
    int subtotal = 0;

    while (std::cin >> subtotal) {
        if (subtotal < 0) {
            std::cerr << "Subtotal cannot be negative.\n";
            return 1;
        }

        const int discountPercent =
            calculateDiscountPercent(subtotal);

        const int discountAmount =
            calculateDiscountAmount(subtotal, discountPercent);

        const int taxableAmount = subtotal - discountAmount;
        const int tax = calculateTax(taxableAmount);
        const int shippingCost =
            calculateShippingCost(subtotal);

        const int total = calculateTotal(
            subtotal,
            discountAmount,
            tax,
            shippingCost
        );

        std::cout
            << discountPercent << " "
            << shippingCost << " "
            << tax << " "
            << total << "\n";
    }

    return 0;
}