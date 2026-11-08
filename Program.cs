var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllersWithViews();

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    app.UseHsts();
}

// The microphone only works in a secure context (HTTPS or localhost).
app.UseHttpsRedirection();

// All audio processing runs in the browser; no audio ever reaches the server.
app.Use(async (context, next) =>
{
    context.Response.Headers["Permissions-Policy"] = "microphone=(self)";
    await next();
});

app.UseStaticFiles();
app.UseRouting();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

app.Run();
