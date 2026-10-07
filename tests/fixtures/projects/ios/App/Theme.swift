import SwiftUI

extension Color {
    static let borderSubtle = Color(red: 214 / 255, green: 214 / 255, blue: 214 / 255)
    static let accent = Color(hex: "#24F4C9")
    static let overlay = Color(red: 0, green: 0, blue: 0, opacity: 0.4)
}

enum Spacing {
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
}

enum Radius {
    static let card: CGFloat = 8
}

extension Font {
    static let title = Font.system(size: 15, weight: .medium)
    static let caption = Font.system(size: 12)
}
