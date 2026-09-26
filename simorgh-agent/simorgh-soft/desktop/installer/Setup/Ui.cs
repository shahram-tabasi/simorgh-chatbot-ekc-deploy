// The pieces the setup screens are drawn with, after the office's artwork:
// the night-blue ground, the blue buttons, the square blue checkboxes, the
// numbered steps and the progress bar. Built in code, so there is no XAML to
// compile (see SimorghSetup.csproj).
using System;
using System.IO;
using Path = System.Windows.Shapes.Path;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;

namespace SimorghSetup
{
    internal static class Ui
    {
        public static readonly FontFamily Font = new FontFamily("Segoe UI");

        public static SolidColorBrush Brush(string hex) =>
            (SolidColorBrush)new BrushConverter().ConvertFromString(hex);

        public static readonly Brush White = Brushes.White;
        public static readonly Brush Soft = Brush("#C9D5E6");      // body text
        public static readonly Brush Muted = Brush("#8FA3BF");     // footers, sizes
        public static readonly Brush Faint = Brush("#5E718C");     // pending steps
        public static readonly Brush Accent = Brush("#1E88F0");    // the blue of the artwork
        public static readonly Brush Line = Brush("#1F3A5F");
        public static readonly Brush Panel = Brush("#0A1D3B");
        public static readonly Brush PanelBorder = Brush("#26436E");

        public static Brush Ground()
        {
            var g = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0.3, 1) };
            g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString("#082047"), 0));
            g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString("#041330"), 0.45));
            g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString("#020A1A"), 1));
            return g;
        }

        public static BitmapImage Image(string name)
        {
            var img = new BitmapImage();
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                var copy = new MemoryStream();
                s.CopyTo(copy);
                copy.Position = 0;
                img.BeginInit();
                img.CacheOption = BitmapCacheOption.OnLoad;
                img.StreamSource = copy;
                img.EndInit();
            }
            img.Freeze();
            return img;
        }

        public static TextBlock Text(string text, double size, Brush color, FontWeight? weight = null, double wrap = 0)
        {
            var t = new TextBlock
            {
                Text = text,
                FontFamily = Font,
                FontSize = size,
                Foreground = color,
                FontWeight = weight ?? FontWeights.Normal,
            };
            TextOptions.SetTextFormattingMode(t, TextFormattingMode.Display);
            if (wrap > 0) { t.TextWrapping = TextWrapping.Wrap; t.Width = wrap; }
            return t;
        }

        public static T At<T>(this T e, Canvas c, double x, double y) where T : UIElement
        {
            Canvas.SetLeft(e, x);
            Canvas.SetTop(e, y);
            c.Children.Add(e);
            return e;
        }

        public static Path Tick(Brush stroke, double scale = 1)
        {
            return new Path
            {
                Data = Geometry.Parse("M 0,5 L 4,9 L 12,1"),
                Stroke = stroke,
                StrokeThickness = 2.2,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                StrokeLineJoin = PenLineJoin.Round,
                LayoutTransform = new ScaleTransform(scale, scale),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
        }

        public static Rectangle Rule(double width, Brush brush) =>
            new Rectangle { Width = width, Height = 1, Fill = brush };

        public static Grid Center(UIElement child, double size)
        {
            var g = new Grid { Width = size, Height = size };
            g.Children.Add(child);
            return g;
        }
    }

    /// <summary>The artwork's buttons: solid blue for going on, outlined dark for the rest.</summary>
    internal sealed class FlatButton : Border
    {
        private readonly bool primary;
        private readonly TextBlock label;
        public event Action Click;

        public FlatButton(string text, bool primary, double width = 112)
        {
            this.primary = primary;
            Width = width;
            Height = 36;
            CornerRadius = new CornerRadius(6);
            BorderThickness = new Thickness(1);
            Cursor = Cursors.Hand;
            label = Ui.Text(text, 13, Ui.White, FontWeights.SemiBold);
            label.HorizontalAlignment = HorizontalAlignment.Center;
            label.VerticalAlignment = VerticalAlignment.Center;
            Child = label;
            Paint(false);
            MouseEnter += (s, e) => Paint(true);
            MouseLeave += (s, e) => Paint(false);
            MouseLeftButtonUp += (s, e) => { if (IsEnabled) Click?.Invoke(); };
            IsEnabledChanged += (s, e) => Paint(false);
        }

        public string Label { set => label.Text = value; }

        private void Paint(bool hover)
        {
            Opacity = IsEnabled ? 1 : 0.45;
            if (primary)
            {
                var g = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0, 1) };
                g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString(hover ? "#4AA3FF" : "#2F93FF"), 0));
                g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString(hover ? "#1F7BEA" : "#1668D8"), 1));
                Background = g;
                BorderBrush = Ui.Brush("#3C9BFF");
            }
            else
            {
                Background = Ui.Brush(hover ? "#16305A" : "#0E2244");
                BorderBrush = Ui.Brush("#3A5A8A");
            }
        }
    }

    /// <summary>A square blue checkbox with its label, as in the artwork.</summary>
    internal sealed class Check : StackPanel
    {
        private readonly Border box;
        private bool isChecked;
        public event Action Changed;
        public bool Locked { get; set; }

        public Check(string text, bool isChecked, double size = 13, Brush color = null)
        {
            Orientation = Orientation.Horizontal;
            Cursor = Cursors.Hand;
            Background = Brushes.Transparent;
            box = new Border
            {
                Width = 18,
                Height = 18,
                CornerRadius = new CornerRadius(3),
                BorderThickness = new Thickness(1.5),
                VerticalAlignment = VerticalAlignment.Center,
                Child = Ui.Tick(Ui.White, 0.9),
            };
            Children.Add(box);
            if (!string.IsNullOrEmpty(text))
            {
                var t = Ui.Text(text, size, color ?? Ui.White);
                t.Margin = new Thickness(10, 0, 0, 0);
                t.VerticalAlignment = VerticalAlignment.Center;
                Children.Add(t);
            }
            IsChecked = isChecked;
            MouseLeftButtonUp += (s, e) => { if (!Locked) { IsChecked = !IsChecked; Changed?.Invoke(); } };
        }

        public bool IsChecked
        {
            get => isChecked;
            set
            {
                isChecked = value;
                box.Background = value ? Ui.Accent : Brushes.Transparent;
                box.BorderBrush = value ? Ui.Accent : Ui.Brush("#6B7F9C");
                box.Child.Visibility = value ? Visibility.Visible : Visibility.Hidden;
            }
        }
    }

    /// <summary>A rounded bar, blue over a dark track.</summary>
    internal sealed class Bar : Grid
    {
        private readonly Border fill;

        public Bar(double width)
        {
            Width = width;
            Height = 9;
            Children.Add(new Border { Background = Ui.Brush("#1A2D4B"), CornerRadius = new CornerRadius(4.5) });
            var g = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(1, 0) };
            g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString("#1E6FE0"), 0));
            g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString("#3AA0FF"), 1));
            fill = new Border { Background = g, CornerRadius = new CornerRadius(4.5), HorizontalAlignment = HorizontalAlignment.Left, Width = 0 };
            Children.Add(fill);
        }

        public double Value { set => fill.Width = Math.Max(0, Math.Min(1, value)) * Width; }
    }

    internal enum StepState { Pending, Current, Done }

    /// <summary>The round marks: a number, a tick when done, a ring with a dot while under way.</summary>
    internal static class Marks
    {
        public static FrameworkElement Numbered(int n, StepState state)
        {
            var g = new Grid { Width = 26, Height = 26 };
            var ring = new Ellipse
            {
                Stroke = state == StepState.Pending ? Ui.Brush("#8FA3BF") : Ui.Accent,
                StrokeThickness = 1.5,
                Fill = state == StepState.Pending ? Brushes.Transparent : Ui.Accent,
            };
            g.Children.Add(ring);
            if (state == StepState.Done) g.Children.Add(Ui.Tick(Ui.White, 0.9));
            else
            {
                var t = Ui.Text(n.ToString(), 13, state == StepState.Pending ? Ui.Soft : Ui.White, FontWeights.SemiBold);
                t.HorizontalAlignment = HorizontalAlignment.Center;
                t.VerticalAlignment = VerticalAlignment.Center;
                g.Children.Add(t);
            }
            return g;
        }

        public static FrameworkElement Progress(StepState state)
        {
            var g = new Grid { Width = 18, Height = 18 };
            switch (state)
            {
                case StepState.Done:
                    g.Children.Add(new Ellipse { Fill = Ui.Accent });
                    g.Children.Add(Ui.Tick(Ui.White, 0.75));
                    break;
                case StepState.Current:
                    g.Children.Add(new Ellipse { Stroke = Ui.Accent, StrokeThickness = 2 });
                    g.Children.Add(new Ellipse { Fill = Ui.Accent, Width = 8, Height = 8 });
                    break;
                default:
                    g.Children.Add(new Ellipse { Stroke = Ui.Brush("#5E718C"), StrokeThickness = 1.5 });
                    break;
            }
            return g;
        }
    }
}
