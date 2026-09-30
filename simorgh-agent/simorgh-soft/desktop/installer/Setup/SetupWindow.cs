// The setup window: the five screens of the office's artwork —
// Welcome, License, Components, Install, Finish — in one borderless window
// with its own title bar, laid out at the artwork's own size (540 × 450
// below a 40-pixel title bar).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using Simorgh;
using Path = System.Windows.Shapes.Path;
using IOPath = System.IO.Path;

namespace SimorghSetup
{
    internal sealed class SetupWindow : Window
    {
        private const double W = 540, H = 450;

        private readonly InstallEngine engine = new InstallEngine();
        private readonly Grid pages = new Grid { Width = W, Height = H, ClipToBounds = true };
        private readonly Border frame;
        private Canvas welcome, license, components, install, finish;
        private Canvas current;

        // Install screen parts
        private readonly List<(FrameworkElement mark, TextBlock text, Canvas host, double x, double y)> steps
            = new List<(FrameworkElement, TextBlock, Canvas, double, double)>();
        private Bar bar;
        private TextBlock percent, installTitle, installNote;
        private FlatButton installCancel;
        private CancellationTokenSource cancel;
        private bool installing, installed;
        private Check launch;
        private TextBlock totalSize;

        public SetupWindow()
        {
            Title = Product.Name + " Setup";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.CanMinimize;
            SizeToContent = SizeToContent.WidthAndHeight;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            try { Icon = Ui.Image("bird.png"); } catch { /* the exe's own icon still shows */ }

            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.Children.Add(TitleBar());
            Grid.SetRow(pages, 1);
            root.Children.Add(pages);

            frame = new Border
            {
                Background = Ui.Ground(),
                BorderBrush = Ui.Brush("#2B4C7E"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Child = root,
                Margin = new Thickness(12), // room for the glow
                Effect = new System.Windows.Media.Effects.DropShadowEffect
                {
                    Color = (Color)ColorConverter.ConvertFromString("#1E6FE0"),
                    BlurRadius = 18, ShadowDepth = 0, Opacity = 0.45,
                },
            };
            // Round the corners of everything inside, the artwork included.
            root.Clip = new RectangleGeometry(new Rect(0, 0, W, H + 40), 7, 7);
            Content = frame;

            BuildWelcome();
            BuildLicense();
            BuildComponents();
            BuildInstall();
            BuildFinish();
            Show(welcome);

            Closing += (s, e) =>
            {
                if (installed || current == welcome || current == finish) return;
                if (installing)
                {
                    if (!AskCancel()) { e.Cancel = true; return; }
                    cancel?.Cancel();
                    return;
                }
                if (!AskCancel()) e.Cancel = true;
            };
        }

        // ── Frame ───────────────────────────────────────────────────────────

        private UIElement TitleBar()
        {
            var bar = new Grid { Background = Brushes.Transparent };
            bar.MouseLeftButtonDown += (s, e) => { if (e.ButtonState == MouseButtonState.Pressed) DragMove(); };
            var left = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            left.Children.Add(new Image { Source = Ui.Image("bird.png"), Width = 18, Height = 18, Margin = new Thickness(0, 0, 10, 0) });
            left.Children.Add(Ui.Text(Product.Name + " Setup", 12.5, Ui.White));
            bar.Children.Add(left);

            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            buttons.Children.Add(ChromeButton("M 0,0.5 L 10,0.5", () => WindowState = WindowState.Minimized));
            buttons.Children.Add(ChromeButton("M 0,0 L 10,10 M 10,0 L 0,10", Close));
            bar.Children.Add(buttons);
            bar.Children.Add(new Rectangle { Height = 1, Fill = Ui.Line, VerticalAlignment = VerticalAlignment.Bottom, Opacity = 0.6 });
            return bar;
        }

        private static UIElement ChromeButton(string glyph, Action click)
        {
            var b = new Border { Width = 44, Height = 40, Background = Brushes.Transparent, Cursor = Cursors.Hand };
            b.Child = new Path
            {
                Data = Geometry.Parse(glyph), Stroke = Ui.Soft, StrokeThickness = 1.2,
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            };
            b.MouseEnter += (s, e) => b.Background = Ui.Brush("#1A3358");
            b.MouseLeave += (s, e) => b.Background = Brushes.Transparent;
            b.MouseLeftButtonUp += (s, e) => click();
            return b;
        }

        private Canvas Page()
        {
            var c = new Canvas { Width = W, Height = H, Visibility = Visibility.Collapsed };
            pages.Children.Add(c);
            return c;
        }

        private void Show(Canvas page)
        {
            foreach (UIElement child in pages.Children) child.Visibility = Visibility.Collapsed;
            page.Visibility = Visibility.Visible;
            current = page;
        }

        private bool AskCancel() =>
            MessageBox.Show(this, "Cancel the installation of " + Product.Name + "?", Title,
                MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No) == MessageBoxResult.Yes;

        private static void Footer(Canvas c) =>
            Ui.Text("Simorgh Technology   |   All rights reserved.", 10.5, Ui.Muted).At(c, 24, 418);

        private static void Streaks(Canvas c, double x, double y, double opacity, bool mirror = false)
        {
            var img = new Image { Source = Ui.Image("streaks.png"), Width = 170, Opacity = opacity, IsHitTestVisible = false };
            if (mirror) { img.RenderTransformOrigin = new Point(0.5, 0.5); img.RenderTransform = new ScaleTransform(-1, 1); }
            img.At(c, x, y);
        }

        /// <summary>The four numbered steps across the top, <paramref name="active"/> 0‥3.</summary>
        private static void Stepper(Canvas c, int active)
        {
            string[] names = { "License", "Components", "Install", "Finish" };
            double[] xs = { 24, 146, 290, 412 };
            for (int i = 0; i < 4; i++)
            {
                var state = i < active ? StepState.Done : i == active ? StepState.Current : StepState.Pending;
                var item = new StackPanel { Orientation = Orientation.Horizontal };
                item.Children.Add(Marks.Numbered(i + 1, state));
                var t = Ui.Text(names[i], 13, state == StepState.Pending ? Ui.Soft : Ui.White,
                    i == active ? FontWeights.SemiBold : FontWeights.Normal);
                t.Margin = new Thickness(10, 0, 0, 0);
                t.VerticalAlignment = VerticalAlignment.Center;
                item.Children.Add(t);
                item.At(c, xs[i], 14);
                if (i == active)
                    new Rectangle { Width = 112, Height = 2, Fill = Ui.Accent, RadiusX = 1, RadiusY = 1 }.At(c, xs[i] - 6, 52);
            }
            Ui.Rule(W, Ui.Line).At(c, 0, 54);
        }

        // ── 1. Welcome ──────────────────────────────────────────────────────

        private void BuildWelcome()
        {
            welcome = Page();
            // The artwork itself: the logo, the tagline and the Simorgh over
            // the lit globe, with its wizard text lifted off (it is set in
            // real text below, so it is sharp at any scale).
            new Image { Source = Ui.Image("welcome.png"), Width = W, Height = H, Stretch = Stretch.Fill }.At(welcome, 0, 0);
            Ui.Text("Welcome to the Simorgh\nDesign Suite Setup Wizard", 16, Ui.White, FontWeights.SemiBold).At(welcome, 26, 246);
            Ui.Text("This wizard will install Simorgh Design Suite on your computer.\nClick Next to continue or Cancel to exit the setup.",
                11.5, Ui.Soft).At(welcome, 26, 312);
            Footer(welcome);
            var next = new FlatButton("Next  →", true, 115).At(welcome, 413, 403);
            next.Click += () => Show(license);
        }

        // ── 2. License ──────────────────────────────────────────────────────

        private void BuildLicense()
        {
            license = Page();
            Stepper(license, 0);
            Ui.Text("License Agreement", 18, Ui.White, FontWeights.SemiBold).At(license, 24, 68);

            var text = LicenseText();
            var body = new StackPanel { Margin = new Thickness(14, 12, 14, 12) };
            var paragraphs = text.Replace("\r\n", "\n").Split(new[] { "\n\n" }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < paragraphs.Length; i++)
            {
                var p = paragraphs[i].Trim();
                bool heading = i == 0 || (p.Length > 2 && char.IsDigit(p[0]) && p[1] == '.');
                if (heading && i > 0 && p.Contains("\n"))
                {
                    // "1. License Grant\nbody…" — the number line as a heading, then its text
                    var nl = p.IndexOf('\n');
                    body.Children.Add(Para(p.Substring(0, nl), true));
                    body.Children.Add(Para(p.Substring(nl + 1), false));
                }
                else body.Children.Add(Para(p, heading));
            }
            var scroll = new ScrollViewer
            {
                Content = body,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Width = W - 48,
                Height = 242,
            };
            ThinScrollBars(scroll);
            new Border
            {
                Child = scroll, Background = Ui.Panel, BorderBrush = Ui.PanelBorder,
                BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(4),
            }.At(license, 24, 104);

            var accept = new Check("I accept the terms of the License Agreement", false).At(license, 24, 362);
            var back = new FlatButton("Back", false).At(license, 294, 398);
            var next = new FlatButton("Next  →", true).At(license, 414, 398);
            next.IsEnabled = false;
            accept.Changed += () => next.IsEnabled = accept.IsChecked;
            back.Click += () => Show(welcome);
            next.Click += () => Show(components);
        }

        private static TextBlock Para(string text, bool heading)
        {
            var t = Ui.Text(text.Replace("\n", " "), heading ? 13 : 12, heading ? Ui.White : Ui.Soft,
                heading ? FontWeights.SemiBold : FontWeights.Normal);
            t.TextWrapping = TextWrapping.Wrap;
            t.LineHeight = heading ? 18 : 18.5;
            t.Margin = new Thickness(0, 0, 0, heading ? 6 : 12);
            return t;
        }

        private static string LicenseText()
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("license.txt"))
            using (var r = new StreamReader(s)) return r.ReadToEnd();
        }

        // A thin blue scrollbar, like the artwork's, in place of Windows' grey one.
        private static void ThinScrollBars(ScrollViewer scroll)
        {
            const string xaml = @"
<Style xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'
       xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ScrollBar'>
  <Setter Property='Width' Value='6'/>
  <Setter Property='MinWidth' Value='6'/>
  <Setter Property='Template'>
    <Setter.Value>
      <ControlTemplate TargetType='ScrollBar'>
        <Track x:Name='PART_Track' IsDirectionReversed='True'>
          <Track.Thumb>
            <Thumb>
              <Thumb.Template>
                <ControlTemplate TargetType='Thumb'>
                  <Border Background='#3A8DEB' CornerRadius='3' Margin='0,2'/>
                </ControlTemplate>
              </Thumb.Template>
            </Thumb>
          </Track.Thumb>
        </Track>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>";
            try
            {
                var style = (Style)System.Windows.Markup.XamlReader.Parse(xaml);
                scroll.Resources.Add(typeof(System.Windows.Controls.Primitives.ScrollBar), style);
            }
            catch { /* Windows' own scrollbar, then */ }
        }

        // ── 3. Components ───────────────────────────────────────────────────

        private void BuildComponents()
        {
            components = Page();
            Stepper(components, 1);
            Ui.Text("Select Components", 18, Ui.White, FontWeights.SemiBold).At(components, 24, 68);
            Ui.Text("Choose the components you want to install. Click Next to continue.", 12, Ui.Soft).At(components, 24, 98);

            var list = new StackPanel { Width = W - 48 };
            foreach (var comp in engine.Components)
            {
                var row = new Grid { Height = 58 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(44) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(58) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });

                var check = new Check(null, comp.Selected) { Locked = comp.Required, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(14, 0, 0, 0) };
                if (comp.Required) check.Opacity = 0.9;
                var c = comp;
                check.Changed += () => { c.Selected = check.IsChecked; UpdateTotal(); };
                row.Children.Add(check);

                var icon = new Border
                {
                    Width = 40, Height = 40, CornerRadius = new CornerRadius(6), Background = Ui.Brush("#0E2548"),
                    BorderBrush = Ui.PanelBorder, BorderThickness = new Thickness(1), Child = Glyph(comp.Icon),
                    VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Left,
                };
                Grid.SetColumn(icon, 1);
                row.Children.Add(icon);

                var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                words.Children.Add(Ui.Text(comp.Title, 13, Ui.White, FontWeights.SemiBold));
                var desc = Ui.Text(comp.Description, 11.5, Ui.Soft);
                desc.Margin = new Thickness(0, 3, 0, 0);
                words.Children.Add(desc);
                Grid.SetColumn(words, 2);
                row.Children.Add(words);

                var size = Ui.Text(InstallEngine.Size(comp.Bytes), 11.5, Ui.Soft);
                size.HorizontalAlignment = HorizontalAlignment.Right;
                size.VerticalAlignment = VerticalAlignment.Center;
                size.Margin = new Thickness(0, 0, 14, 0);
                Grid.SetColumn(size, 3);
                row.Children.Add(size);

                var cell = new Border
                {
                    Child = row,
                    BorderBrush = Ui.PanelBorder,
                    BorderThickness = new Thickness(0, list.Children.Count == 0 ? 0 : 1, 0, 0),
                };
                if (!comp.Required)
                {
                    cell.Background = Brushes.Transparent;
                    cell.Cursor = Cursors.Hand;
                    cell.MouseLeftButtonUp += (s, e) =>
                    {
                        if (e.OriginalSource is DependencyObject d && IsInside(d, check)) return; // the box handles its own click
                        check.IsChecked = !check.IsChecked;
                        c.Selected = check.IsChecked;
                        UpdateTotal();
                    };
                }
                list.Children.Add(cell);
            }
            new Border
            {
                Child = list, Background = Ui.Panel, BorderBrush = Ui.PanelBorder,
                BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(4),
            }.At(components, 24, 126);

            totalSize = Ui.Text("", 12, Ui.Soft).At(components, 24, 407);
            UpdateTotal();
            var back = new FlatButton("Back", false).At(components, 294, 398);
            var next = new FlatButton("Next  →", true).At(components, 414, 398);
            back.Click += () => Show(license);
            next.Click += StartInstall;
        }

        private static bool IsInside(DependencyObject d, DependencyObject ancestor)
        {
            for (; d != null; d = VisualTreeHelper.GetParent(d))
                if (d == ancestor) return true;
            return false;
        }

        private void UpdateTotal() => totalSize.Text = "Total size: " + InstallEngine.Size(engine.TotalBytes);

        private static FrameworkElement Glyph(string kind)
        {
            if (kind == "logo")
                return new Image { Source = Ui.Image("bird.png"), Width = 28, Height = 28 };
            string data;
            switch (kind)
            {
                case "db":   data = "M 0,3 A 9,3 0 1 0 18,3 A 9,3 0 1 0 0,3 M 0,3 L 0,17 A 9,3 0 0 0 18,17 L 18,3 M 0,10 A 9,3 0 0 0 18,10"; break;
                case "link": data = "M 2,2 L 16,2 L 16,16 L 2,16 Z M 6,12 L 12,6 M 7,6 L 12,6 L 12,11"; break;
                default:     data = "M 2,2 L 8,2 L 8,8 L 2,8 Z M 10,2 L 16,2 L 16,8 L 10,8 Z M 2,10 L 8,10 L 8,16 L 2,16 Z M 10,10 L 16,10 L 16,16 L 10,16 Z"; break;
            }
            return new Path
            {
                Data = Geometry.Parse(data), Stroke = Ui.Brush("#DCE8F7"), StrokeThickness = 1.4,
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
                StrokeLineJoin = PenLineJoin.Round,
            };
        }

        // ── 4. Install ──────────────────────────────────────────────────────

        private void BuildInstall()
        {
            install = Page();
            Streaks(install, 372, 150, 0.95);
            Stepper(install, 2);
            installTitle = Ui.Text("Installing", 18, Ui.White, FontWeights.SemiBold).At(install, 24, 68);
            installNote = Ui.Text("Please wait while Setup installs Simorgh Design Suite on your computer.", 12, Ui.Soft, null, W - 48).At(install, 24, 98);
            string[] names = { "Copying files", "Installing features", "Configuring application", "Finalizing installation" };
            for (int i = 0; i < names.Length; i++)
            {
                double y = 132 + i * 31;
                var mark = Marks.Progress(StepState.Pending).At(install, 24, y);
                var text = Ui.Text(names[i], 12.5, Ui.Faint).At(install, 52, y);
                steps.Add((mark, text, install, 24, y));
            }
            bar = new Bar(W - 48).At(install, 24, 296);
            percent = Ui.Text("Installing... 0%", 12, Ui.Soft).At(install, 24, 316);
            Footer(install);
            installCancel = new FlatButton("Cancel", false).At(install, 414, 398);
            installCancel.Click += () => { if (AskCancel()) cancel?.Cancel(); };
        }

        private void SetStep(int active)
        {
            for (int i = 0; i < steps.Count; i++)
            {
                var (mark, text, host, x, y) = steps[i];
                var state = i < active ? StepState.Done : i == active ? StepState.Current : StepState.Pending;
                host.Children.Remove(mark);
                var fresh = Marks.Progress(state).At(host, x, y);
                steps[i] = (fresh, text, host, x, y);
                text.Foreground = state == StepState.Pending ? Ui.Faint : Ui.White;
                text.FontWeight = state == StepState.Current ? FontWeights.SemiBold : FontWeights.Normal;
            }
        }

        private void SetProgress(double value)
        {
            bar.Value = value;
            percent.Text = $"Installing... {Math.Round(value * 100)}%";
        }

        private async void StartInstall()
        {
            var blocking = InstallEngine.Blocking();
            if (blocking.Length > 0 && MessageBox.Show(this,
                    Product.Name + " is running. Close it and continue the installation?", Title,
                    MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
                return;

            Show(install);
            installing = true;
            cancel = new CancellationTokenSource();
            var token = cancel.Token;
            try
            {
                await Task.Run(() => engine.Run(
                    i => Dispatcher.Invoke(() => SetStep(i)),
                    v => Dispatcher.BeginInvoke(new Action(() => SetProgress(v))),
                    token));
                SetStep(4);
                SetProgress(1);
                installed = true;
                await Task.Delay(500);
                Show(finish);
            }
            catch (OperationCanceledException)
            {
                installTitle.Text = "Installation cancelled";
                installNote.Text = "Nothing more was installed. Run Setup again to install " + Product.Name + ".";
                Done();
            }
            catch (Exception ex)
            {
                installTitle.Text = "Installation failed";
                installNote.Text = ex.Message;
                installNote.Foreground = Ui.Brush("#F87171");
                Done();
            }
            finally
            {
                installing = false;
            }

            void Done()
            {
                installed = true; // nothing left to cancel: closing just closes
                installCancel.Label = "Close";
                installCancel.Click += Close;
            }
        }

        // ── 5. Finish ───────────────────────────────────────────────────────

        private void BuildFinish()
        {
            finish = Page();
            Streaks(finish, 380, 170, 0.9);
            Streaks(finish, -10, 170, 0.6, mirror: true);

            var logo = new Image { Source = Ui.Image("logo.png"), Width = 250 };
            logo.At(finish, (W - 250) / 2, 26);
            // The glow line under the logo, as in the artwork.
            var glow = new Rectangle { Width = 300, Height = 2 };
            var g = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(1, 0) };
            g.GradientStops.Add(new GradientStop(Colors.Transparent, 0));
            g.GradientStops.Add(new GradientStop((Color)ColorConverter.ConvertFromString("#3AA0FF"), 0.5));
            g.GradientStops.Add(new GradientStop(Colors.Transparent, 1));
            glow.Fill = g;
            glow.At(finish, (W - 300) / 2, 128);

            var ok = new Grid { Width = 38, Height = 38 };
            ok.Children.Add(new Ellipse { Stroke = Ui.Brush("#10B981"), StrokeThickness = 2.2, Fill = Ui.Brush("#0B2A2E") });
            ok.Children.Add(Ui.Tick(Ui.Brush("#34D399"), 1.25));
            ok.At(finish, (W - 38) / 2, 150);

            Centered(Ui.Text("Installation Completed", 18, Ui.White, FontWeights.SemiBold), 202);
            var msg = Ui.Text("Simorgh Design Suite has been successfully installed\non your computer.", 12.5, Ui.Soft);
            msg.TextAlignment = TextAlignment.Center;
            Centered(msg, 236);

            launch = new Check("Launch Simorgh Design Suite now", true, 12.5).At(finish, 70, 306);
            Footer(finish);
            var done = new FlatButton("Finish", true).At(finish, 414, 398);
            done.Click += () =>
            {
                if (launch.IsChecked) engine.Launch();
                Close();
            };
        }

        private void Centered(FrameworkElement e, double y)
        {
            e.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            e.At(finish, (W - e.DesiredSize.Width) / 2, y);
        }

        // ── Pictures of every screen, for checking the build ────────────────

        /// <summary>Render each screen to a PNG in <paramref name="dir"/> (used by the build to show what it made).</summary>
        public void SaveScreens(string dir)
        {
            Directory.CreateDirectory(dir);
            var shots = new (string name, Canvas page, Action prepare)[]
            {
                ("1-welcome", welcome, null),
                ("2-license", license, null),
                ("3-components", components, null),
                ("4-install", install, () => { SetStep(2); SetProgress(0.68); }),
                ("5-finish", finish, null),
            };
            foreach (var (name, page, prepare) in shots)
            {
                Show(page);
                prepare?.Invoke();
                frame.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                frame.Arrange(new Rect(frame.DesiredSize));
                frame.UpdateLayout();
                var size = frame.DesiredSize;
                var rtb = new RenderTargetBitmap((int)Math.Ceiling(size.Width * 2), (int)Math.Ceiling(size.Height * 2), 192, 192, PixelFormats.Pbgra32);
                rtb.Render(frame);
                var png = new PngBitmapEncoder();
                png.Frames.Add(BitmapFrame.Create(rtb));
                using (var f = File.Create(IOPath.Combine(dir, name + ".png"))) png.Save(f);
            }
        }
    }
}
