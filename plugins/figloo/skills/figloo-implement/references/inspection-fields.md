# Inspection panel fields

Figloo returns the inspection panel as Figma shows it, without converting values. A property inside a group comes as `{ group, name, value }`, so the panel's `Padding—Top: 24px` arrives as `group: "Padding"`, `name: "Top"`, `value: "24px"`; a property outside a group has `group: null`.

The equivalents below are starting points. Prefer the project's own tokens and components over literal values, and compare the result with the snapshot's screenshot.

## Size and place

| Field | Example | CSS | SwiftUI | Jetpack Compose |
|---|---|---|---|---|
| `Width`, `Height` fixed | `460px` | `width: 460px` | `.frame(width: 460)` | `Modifier.width(460.dp)` |
| `Width`, `Height` hug | `Hug (393px)`: sizes to its content, 393 px right now | `width: fit-content`, or leave it to the content | No frame; the view's own size | `wrapContentWidth()`, or no size modifier |
| `Top`, `Left` | `24px` | Offsets inside the parent frame; use them only when that frame has no auto layout | `.offset` or `.position` in a `ZStack` | `Modifier.offset` in a `Box` |
| `Rotation` | degrees | `transform: rotate(…deg)` | `.rotationEffect(.degrees(…))` | `Modifier.rotate(…f)` |

Sizing modes other than fixed and hug follow the same pattern, a mode with the current size in parentheses; a layer that stretches to fill its parent maps to `flex: 1` or `align-self: stretch`, `.frame(maxWidth: .infinity)`, or `fillMaxWidth()` and `weight(1f)`.

## Auto layout

| Field | Example | CSS | SwiftUI | Jetpack Compose |
|---|---|---|---|---|
| `Flow` | `Vertical`, `Horizontal` | `display: flex; flex-direction: column` or `row` | `VStack`, `HStack` | `Column`, `Row` |
| `Gap` | `10px` | `gap: 10px` | `spacing: 10` | `Arrangement.spacedBy(10.dp)` |
| `Padding` with `Top`, `Right`, `Bottom`, `Left` | `24px` | `padding: 24px 19px 24px 19px` | `.padding(EdgeInsets(top: 24, leading: 19, bottom: 24, trailing: 19))` | `Modifier.padding(start = 19.dp, top = 24.dp, end = 19.dp, bottom = 24.dp)` |

Children of an auto layout frame show `?,?` or panel-derived places in the outline; lay them out with the container, in outline order.

## Appearance

| Field | Example | CSS | SwiftUI | Jetpack Compose |
|---|---|---|---|---|
| `Radius`, or `Radius` with `Top-left`, `Top-right`, `Bottom-right`, `Bottom-left` | `16px` | `border-radius`, per corner when they differ | `RoundedRectangle(cornerRadius:)`, or `UnevenRoundedRectangle` per corner | `RoundedCornerShape(topStart = 16.dp, …)` |
| Colors | `#08458A` at `80%`, or a style name | `color` or `background` with the opacity as alpha | `Color` with `.opacity(0.8)` | `Color(0xFF08458A).copy(alpha = 0.8f)` |
| Borders | weight, color | `border` | `.overlay(shape.stroke(color, lineWidth:))` | `Modifier.border(width, color, shape)` |
| `Drop shadow` with `X`, `Y`, `Blur`, `Spread` | `0`, `-4`, `8`, `0` | `box-shadow: 0 -4px 8px 0 color` | `.shadow(color:radius:x:y:)` | `Modifier.shadow(elevation, shape)` |

A color given as a name is a Figma color style: map it to the project's token of the same meaning. SwiftUI's shadow radius and Compose's elevation do not use Figma's blur scale; tune them against the screenshot.

## Typography

| Field | Example | CSS | SwiftUI | Jetpack Compose |
|---|---|---|---|---|
| `Font` | `Roboto` | `font-family` | `.font(.custom("Roboto", size: 24))` | `FontFamily` in a `TextStyle` |
| `Weight`, `Style` | `500`, `Medium` | `font-weight: 500` | `.fontWeight(.medium)` | `FontWeight.Medium` |
| `Size` | `24px` | `font-size: 24px` | the `size:` of the font | `fontSize = 24.sp` |
| `Line height` | `150%`, or a pixel value | `line-height: 1.5`, or the pixel value | `.lineSpacing` takes the extra space between lines, not the line height | `lineHeight = 1.5.em` or `36.sp` |
| `Letter spacing` | `2%` of the size, or a pixel value | `letter-spacing: 0.02em` | `.tracking(size × 0.02)` in points | `letterSpacing = 0.02.em` |

A text layer whose text mixes styles has one typography section per run (`typography1`, `typography2`, and so on): build it as styled spans, an `AttributedString`, or an `AnnotatedString`.

## Components and content

| Section or field | Meaning |
|---|---|
| `Property` in the component group | An instance's component property and its value, such as a variant; pass it as a prop or parameter of the matching component |
| `selection_hierarchy` | Its `text` names the component an instance comes from |
| `content` | Its `text` is the layer's full text |
